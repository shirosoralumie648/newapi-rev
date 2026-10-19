/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/

import { useAuthStore } from '@/stores/auth-store'

import {
  applyPlaygroundMessagesDelta,
  createPlaygroundSession,
  getPlaygroundMessages,
  updatePlaygroundSession,
} from '../api'
import type { PlaygroundMessageDelta } from '../api'
import type {
  Message,
  PlaygroundSession,
  PlaygroundServerSession,
} from '../types'
import { normalizeMessagesForStorage } from './storage/storage'

/**
 * Client-side view of what the server already stores: per canonical session id,
 * the serialized form of every message the last acknowledged write persisted.
 * It is rebuilt from the server snapshot on hydration, so a save only sends the
 * messages that actually changed.
 */
export type PlaygroundSyncedMessages = Map<string, Map<string, string>>

export function playgroundSyncedSnapshot(
  messages: Message[]
): Map<string, string> {
  return new Map(
    messages.map((message) => [message.key, JSON.stringify(message)])
  )
}

/**
 * The delta the server still needs: changed or new messages, plus the client
 * keys it must remove. An empty delta means the stored snapshot already matches.
 */
export function playgroundMessageDelta(
  synced: Map<string, string> | undefined,
  messages: Message[]
): PlaygroundMessageDelta {
  const present = new Set<string>()
  const upserts: Message[] = []
  for (const message of messages) {
    present.add(message.key)
    if (synced?.get(message.key) !== JSON.stringify(message)) {
      upserts.push(message)
    }
  }
  const deletes = [...(synced?.keys() ?? [])].filter((key) => !present.has(key))
  return { upserts, deletes }
}

export function assertPlaygroundOwner(
  owner: number,
  signal: AbortSignal
): void {
  if (signal.aborted || useAuthStore.getState().auth.user?.id !== owner) {
    throw new DOMException('Playground owner changed', 'AbortError')
  }
}

export function playgroundSnapshot(session: PlaygroundSession): string {
  return JSON.stringify({
    title: session.title,
    config: session.config,
    parameterEnabled: session.parameterEnabled,
    systemPrompt: session.systemPrompt,
    openingMessage: session.openingMessage,
    suggestedQuestions: session.suggestedQuestions,
    context: session.context,
    contextSummary: session.contextSummary,
    messages: normalizeMessagesForStorage(session.messages),
  })
}

export async function hydratePlaygroundWorkspace(
  local: PlaygroundSession[],
  remote: PlaygroundServerSession[],
  deleted: string[],
  owner: number,
  signal: AbortSignal,
  synced: PlaygroundSyncedMessages
): Promise<PlaygroundSession[]> {
  const result: PlaygroundSession[] = []
  const matched = new Set<string>()
  for (const session of remote) {
    if (deleted.includes(session.id)) continue
    assertPlaygroundOwner(owner, signal)
    const draft = local.find(
      (item) =>
        item.server?.id === session.id ||
        (!item.server && item.id === session.clientId)
    )
    if (draft) matched.add(draft.id)
    if (draft?.syncPending) {
      // The stored snapshot of a pending draft is unknown: the next save sends
      // every local message and the server writes only the rows that differ.
      synced.delete(session.id)
      result.push({
        ...draft,
        server: draft.server ?? {
          id: session.id,
          revision: 0,
          messageRevision: 0,
        },
      })
      continue
    }
    const snapshot = await getPlaygroundMessages(session.id, signal)
    const messages = normalizeMessagesForStorage(snapshot.messages)
    synced.set(session.id, playgroundSyncedSnapshot(messages))
    result.push({
      id: draft?.id ?? session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      config: session.config,
      parameterEnabled: session.parameterEnabled,
      systemPrompt: session.systemPrompt,
      openingMessage: session.openingMessage,
      suggestedQuestions: session.suggestedQuestions,
      context: session.context,
      contextSummary: session.contextSummary,
      messages,
      server: {
        id: session.id,
        revision: session.revision,
        messageRevision: snapshot.revision,
      },
      syncPending: false,
    })
  }
  // Server wins on the initial migration, except for explicitly pending drafts.
  // A partial migration is resumed by client ID; POST itself includes the messages atomically.
  const migrating = remote.every((session) =>
    local.some((item) => item.id === session.clientId)
  )
  for (const draft of local) {
    if (
      matched.has(draft.id) ||
      (draft.server && deleted.includes(draft.server.id))
    ) {
      continue
    }
    if (draft.syncPending || (!draft.server && migrating)) {
      result.push({ ...draft, syncPending: true })
    }
  }
  assertPlaygroundOwner(owner, signal)
  return result
}

export async function savePlaygroundSession(
  draft: PlaygroundSession,
  owner: number,
  signal: AbortSignal,
  acknowledge: (server: NonNullable<PlaygroundSession['server']>) => void,
  synced: PlaygroundSyncedMessages
): Promise<void> {
  assertPlaygroundOwner(owner, signal)
  const messages = normalizeMessagesForStorage(draft.messages)
  if (!draft.server) {
    const created = await createPlaygroundSession(
      {
        client_id: draft.id,
        title: draft.title,
        config: draft.config,
        parameter_enabled: draft.parameterEnabled,
        system_prompt: draft.systemPrompt,
        opening_message: draft.openingMessage,
        suggested_questions: draft.suggestedQuestions,
        context: draft.context,
        context_summary: draft.contextSummary,
        messages,
      },
      signal
    )
    assertPlaygroundOwner(owner, signal)
    if (created.created) {
      synced.set(created.id, playgroundSyncedSnapshot(messages))
      acknowledge({
        id: created.id,
        revision: created.revision,
        messageRevision: created.messageRevision,
      })
      return
    }
    // A lost create response can be retried safely: bind canonical state, then compare.
    const snapshot = await getPlaygroundMessages(created.id, signal)
    assertPlaygroundOwner(owner, signal)
    const serverMessages = normalizeMessagesForStorage(snapshot.messages)
    const server = {
      id: created.id,
      revision: created.revision,
      messageRevision: snapshot.revision,
    }
    if (
      JSON.stringify(serverMessages) !== JSON.stringify(messages) ||
      created.title !== draft.title ||
      JSON.stringify(created.config) !== JSON.stringify(draft.config) ||
      JSON.stringify(created.parameterEnabled) !==
        JSON.stringify(draft.parameterEnabled) ||
      created.systemPrompt !== draft.systemPrompt ||
      created.openingMessage !== draft.openingMessage ||
      JSON.stringify(created.suggestedQuestions) !==
        JSON.stringify(draft.suggestedQuestions) ||
      JSON.stringify(created.context) !== JSON.stringify(draft.context) ||
      JSON.stringify(created.contextSummary) !==
        JSON.stringify(draft.contextSummary)
    ) {
      throw new Error(
        'Playground changed on another device. Reload before saving.'
      )
    }
    synced.set(created.id, playgroundSyncedSnapshot(serverMessages))
    acknowledge(server)
    return
  }
  const updated = await updatePlaygroundSession(
    draft.server.id,
    {
      title: draft.title,
      config: draft.config,
      parameter_enabled: draft.parameterEnabled,
      system_prompt: draft.systemPrompt,
      opening_message: draft.openingMessage,
      suggested_questions: draft.suggestedQuestions,
      context: draft.context,
      context_summary: draft.contextSummary,
      revision: draft.server.revision,
    },
    signal
  )
  assertPlaygroundOwner(owner, signal)
  // A metadata PATCH must not advance the message revision from another editor.
  const server = { ...draft.server, revision: updated.revision }
  acknowledge(server)
  const delta = playgroundMessageDelta(synced.get(server.id), messages)
  if (delta.upserts.length === 0 && delta.deletes.length === 0) {
    // The stored snapshot already matches, so the revision stays where it is and
    // no message row is written.
    synced.set(server.id, playgroundSyncedSnapshot(messages))
    return
  }
  const revision = await applyPlaygroundMessagesDelta(
    server.id,
    delta,
    server.messageRevision,
    signal
  )
  assertPlaygroundOwner(owner, signal)
  synced.set(server.id, playgroundSyncedSnapshot(messages))
  acknowledge({ ...server, messageRevision: revision })
}
