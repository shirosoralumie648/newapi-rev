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
  createPlaygroundSession,
  getPlaygroundMessages,
  replacePlaygroundMessages,
  updatePlaygroundSession,
} from '../api'
import type { PlaygroundSession, PlaygroundServerSession } from '../types'
import { normalizeMessagesForStorage } from './storage/storage'

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
    messages: normalizeMessagesForStorage(session.messages),
  })
}

export async function hydratePlaygroundWorkspace(
  local: PlaygroundSession[],
  remote: PlaygroundServerSession[],
  deleted: string[],
  owner: number,
  signal: AbortSignal
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
    result.push({
      id: draft?.id ?? session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      config: session.config,
      parameterEnabled: session.parameterEnabled,
      messages: normalizeMessagesForStorage(snapshot.messages),
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
  acknowledge: (server: NonNullable<PlaygroundSession['server']>) => void
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
        messages,
      },
      signal
    )
    assertPlaygroundOwner(owner, signal)
    if (created.created) {
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
    const server = {
      id: created.id,
      revision: created.revision,
      messageRevision: snapshot.revision,
    }
    if (
      JSON.stringify(normalizeMessagesForStorage(snapshot.messages)) !==
        JSON.stringify(messages) ||
      created.title !== draft.title ||
      JSON.stringify(created.config) !== JSON.stringify(draft.config) ||
      JSON.stringify(created.parameterEnabled) !==
        JSON.stringify(draft.parameterEnabled)
    ) {
      throw new Error(
        'Playground changed on another device. Reload before saving.'
      )
    }
    acknowledge(server)
    return
  }
  const updated = await updatePlaygroundSession(
    draft.server.id,
    {
      title: draft.title,
      config: draft.config,
      parameter_enabled: draft.parameterEnabled,
      revision: draft.server.revision,
    },
    signal
  )
  assertPlaygroundOwner(owner, signal)
  // A metadata PATCH must not advance the message revision from another editor.
  const server = { ...draft.server, revision: updated.revision }
  acknowledge(server)
  const saved = await replacePlaygroundMessages(
    server.id,
    messages,
    server.messageRevision,
    signal
  )
  assertPlaygroundOwner(owner, signal)
  acknowledge({ ...server, messageRevision: saved.revision })
}
