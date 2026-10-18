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
import i18next from 'i18next'

import { handleServerError } from '@/lib/handle-server-error'
import { getServerErrorSources } from '@/lib/server-error-message'

import { getPlaygroundDocumentText } from '../api'
import {
  PLAYGROUND_DOCUMENT_CONTEXT_CLOSE,
  PLAYGROUND_DOCUMENT_CONTEXT_MISSING,
  PLAYGROUND_DOCUMENT_CONTEXT_OPEN,
  isPlaygroundDocumentMediaType,
} from '../constants'
import type { Message, MessageAttachment } from '../types'
import { getCurrentVersion } from './message/message-utils'

/**
 * Document attachments reach the model as their extracted text, not as bytes.
 * The server parses a stored document once and caches the outcome, so the
 * client resolves each document at send time, keeps the text in memory for the
 * rest of the session, and reports a failure once instead of on every send.
 */
interface PlaygroundDocumentTextEntry {
  text: string
  pageCount: number
}

const documentTexts = new Map<string, PlaygroundDocumentTextEntry>()
// Outcomes the server marked final. They are not requested again; the payload
// keeps the placeholder so the model still knows an attachment was sent.
const terminalDocuments = new Set<string>()
const reportedDocuments = new Set<string>()
const pendingDocuments = new Map<string, Promise<void>>()

// The extraction failures the server reports with a stable code. Any other
// error (a network failure, a server error) is retried on the next send.
const PLAYGROUND_DOCUMENT_FAILURE_CODES = new Set([
  'PLAYGROUND_DOCUMENT_UNSUPPORTED',
  'PLAYGROUND_DOCUMENT_LIMIT_EXCEEDED',
  'PLAYGROUND_DOCUMENT_UNREADABLE',
  'PLAYGROUND_DOCUMENT_NO_TEXT',
])

/** Fallback i18n key when a document failure carries no stable server code. */
export const PLAYGROUND_DOCUMENT_LOAD_FAILED =
  'The document text could not be loaded.'

/**
 * The model-facing context of the document attachments of one message. Text
 * resolved by ensurePlaygroundDocumentTexts becomes a framed block; any other
 * document contributes the placeholder.
 */
export function playgroundDocumentContextText(
  attachments: readonly MessageAttachment[]
): string {
  const blocks: string[] = []
  for (const attachment of attachments) {
    if (!isPlaygroundDocumentMediaType(attachment.mediaType)) continue
    const name = attachment.filename?.trim() || 'attachment'
    const entry = documentTexts.get(attachment.id)
    if (entry) {
      blocks.push(
        `${PLAYGROUND_DOCUMENT_CONTEXT_OPEN.replace('{{name}}', name)}\n${entry.text}\n${PLAYGROUND_DOCUMENT_CONTEXT_CLOSE}`
      )
      continue
    }
    blocks.push(PLAYGROUND_DOCUMENT_CONTEXT_MISSING.replace('{{name}}', name))
  }
  return blocks.join('\n\n')
}

/**
 * Resolves the text of every document attachment the outgoing messages carry
 * but have not resolved yet. Each document is requested once; a failure is
 * reported once and leaves the placeholder in the payload, and an outcome the
 * server marked final is not requested again.
 */
export async function ensurePlaygroundDocumentTexts(
  messages: readonly Message[]
): Promise<void> {
  const documents = new Map<string, MessageAttachment>()
  for (const message of messages) {
    for (const attachment of getCurrentVersion(message).attachments ?? []) {
      if (!isPlaygroundDocumentMediaType(attachment.mediaType)) continue
      if (!attachment.url) continue
      if (
        documentTexts.has(attachment.id) ||
        terminalDocuments.has(attachment.id)
      ) {
        continue
      }
      documents.set(attachment.id, attachment)
    }
  }
  if (documents.size === 0) return
  await Promise.all(
    [...documents.values()].map((attachment) => resolveDocumentText(attachment))
  )
}

function resolveDocumentText(attachment: MessageAttachment): Promise<void> {
  const pending = pendingDocuments.get(attachment.id)
  if (pending) return pending
  const request = (async () => {
    try {
      const document = await getPlaygroundDocumentText(attachment.url)
      documentTexts.set(attachment.id, {
        text: document.text,
        pageCount: document.pageCount,
      })
    } catch (error) {
      if (playgroundDocumentFailureCode(error)) {
        terminalDocuments.add(attachment.id)
      }
      reportDocumentFailure(attachment.id, error)
    } finally {
      pendingDocuments.delete(attachment.id)
    }
  })()
  pendingDocuments.set(attachment.id, request)
  return request
}

function playgroundDocumentFailureCode(error: unknown): string | undefined {
  for (const source of getServerErrorSources(error)) {
    if (
      typeof source.code === 'string' &&
      PLAYGROUND_DOCUMENT_FAILURE_CODES.has(source.code)
    ) {
      return source.code
    }
  }
  return undefined
}

function reportDocumentFailure(id: string, error: unknown): void {
  if (reportedDocuments.has(id)) return
  reportedDocuments.add(id)
  handleServerError(error, i18next.t(PLAYGROUND_DOCUMENT_LOAD_FAILED))
}
