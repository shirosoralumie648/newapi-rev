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
import { describe, expect, test } from 'vitest'

import type { Message } from '../../types'
import {
  applyMessageEdit,
  createRegeneratedMessages,
} from '../message/conversation-message-utils'
import {
  appendMessageVersion,
  formatMessageForAPI,
  getActiveVersionIndex,
  getCurrentVersion,
  getMessageContent,
  setActiveMessageVersion,
  updateCurrentVersionContent,
} from '../message/message-utils'
import { messagesSchema } from '../storage/storage-schema'
import { normalizeMessagesForStorage } from '../storage/storage'

function userMessage(overrides: Partial<Message> = {}): Message {
  return {
    key: 'user-1',
    from: 'user',
    versions: [{ id: 'u1', content: 'Original prompt' }],
    ...overrides,
  }
}

function assistantMessage(overrides: Partial<Message> = {}): Message {
  return {
    key: 'assistant-1',
    from: 'assistant',
    versions: [{ id: 'a1', content: 'Original answer' }],
    status: 'complete',
    isContentComplete: true,
    ...overrides,
  }
}

describe('message version selection', () => {
  test('legacy messages without an active index fall back to the first version', () => {
    const message = userMessage({
      versions: [{ id: 'u1', content: 'First' }],
    })

    expect(getActiveVersionIndex(message)).toBe(0)
    expect(getCurrentVersion(message).id).toBe('u1')
    expect(getMessageContent(message)).toBe('First')
  })

  test('a stale active index clamps to the first available version', () => {
    const message = userMessage({
      versions: [{ id: 'u1', content: 'First' }],
      activeVersionIndex: 5,
    })

    expect(getActiveVersionIndex(message)).toBe(0)
    expect(getMessageContent(message)).toBe('First')
  })

  test('appending a version keeps the previous answer and selects the new one', () => {
    const updated = appendMessageVersion(
      assistantMessage(),
      'Regenerated answer'
    )

    expect(updated.versions.map((version) => version.content)).toEqual([
      'Original answer',
      'Regenerated answer',
    ])
    expect(updated.activeVersionIndex).toBe(1)
    expect(getMessageContent(updated)).toBe('Regenerated answer')
  })

  test('updating content edits only the active version', () => {
    const branched = assistantMessage({
      versions: [
        { id: 'a1', content: 'Original answer' },
        { id: 'a2', content: 'Streaming draft' },
      ],
      activeVersionIndex: 1,
    })

    const updated = updateCurrentVersionContent(branched, 'Streaming draft v2')

    expect(updated.versions.map((version) => version.content)).toEqual([
      'Original answer',
      'Streaming draft v2',
    ])
    expect(getMessageContent(updated)).toBe('Streaming draft v2')
  })

  test('selecting an out-of-range version is ignored', () => {
    const message = assistantMessage()

    expect(setActiveMessageVersion(message, 3)).toBe(message)
    expect(setActiveMessageVersion(message, -1)).toBe(message)
  })
})

describe('edit and regenerate branch history', () => {
  test('saving an edit appends a version instead of replacing the prompt', () => {
    const result = applyMessageEdit(
      [userMessage(), assistantMessage()],
      'user-1',
      'Edited prompt',
      false
    )

    expect(result).not.toBeNull()
    const edited = result?.messages[0]
    expect(edited?.versions.map((version) => version.content)).toEqual([
      'Original prompt',
      'Edited prompt',
    ])
    expect(getMessageContent(edited as Message)).toBe('Edited prompt')
    expect(result?.shouldSend).toBe(false)
    expect(result?.messages).toHaveLength(2)
  })

  test('submitting an edit keeps the prompt branch and regenerates the reply version', () => {
    const result = applyMessageEdit(
      [userMessage(), assistantMessage()],
      'user-1',
      'Edited prompt',
      true
    )

    expect(result?.shouldSend).toBe(true)
    expect(result?.messages).toHaveLength(2)
    const editedPrompt = result?.messages[0] as Message
    const regenerated = result?.messages[1] as Message
    expect(editedPrompt.versions).toHaveLength(2)
    expect(regenerated.from).toBe('assistant')
    expect(regenerated.status).toBe('loading')
    expect(regenerated.versions).toHaveLength(2)
    expect(regenerated.versions[0].content).toBe('Original answer')
    expect(regenerated.activeVersionIndex).toBe(1)
  })

  test('regenerating an assistant reply keeps the previous answer as a branch', () => {
    const next = createRegeneratedMessages(
      [userMessage(), assistantMessage()],
      'assistant-1'
    )

    expect(next).not.toBeNull()
    expect(next).toHaveLength(2)
    const regenerated = next?.[1] as Message
    expect(regenerated.key).toBe('assistant-1')
    expect(regenerated.status).toBe('loading')
    expect(regenerated.versions.map((version) => version.content)).toEqual([
      'Original answer',
      '',
    ])
    expect(getMessageContent(regenerated)).toBe('')
  })

  test('regenerating a user message reuses the following reply as a new version', () => {
    const next = createRegeneratedMessages(
      [userMessage(), assistantMessage()],
      'user-1'
    )

    expect(next).toHaveLength(2)
    const regenerated = next?.[1] as Message
    expect(regenerated.key).toBe('assistant-1')
    expect(regenerated.versions).toHaveLength(2)
    expect(regenerated.versions[0].content).toBe('Original answer')
    expect(regenerated.activeVersionIndex).toBe(1)
  })
})

describe('active version in the request payload and storage', () => {
  test('formatMessageForAPI sends the active branch content', () => {
    const message = userMessage({
      versions: [
        { id: 'u1', content: 'Original prompt' },
        { id: 'u2', content: 'Edited prompt' },
      ],
      activeVersionIndex: 1,
    })

    expect(formatMessageForAPI(message)).toEqual({
      role: 'user',
      content: 'Edited prompt',
    })
  })

  test('normalizing for storage keeps every version and the active index', () => {
    const message = assistantMessage({
      versions: [
        { id: 'a1', content: 'Original answer' },
        { id: 'a2', content: 'Regenerated answer' },
      ],
      activeVersionIndex: 1,
    })

    const normalized = normalizeMessagesForStorage([message])

    expect(normalized).toHaveLength(1)
    expect(normalized[0].versions.map((version) => version.content)).toEqual([
      'Original answer',
      'Regenerated answer',
    ])
    expect(normalized[0].activeVersionIndex).toBe(1)
  })

  test('the message schema accepts multiple versions and an active index', () => {
    const parsed = messagesSchema.safeParse([
      userMessage({
        versions: [
          { id: 'u1', content: 'Original prompt' },
          { id: 'u2', content: 'Edited prompt' },
        ],
        activeVersionIndex: 1,
      }),
    ])

    expect(parsed.success).toBe(true)
  })
})
