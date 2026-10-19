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
import { useCallback, useEffect, useRef } from 'react'

import { sendChatCompletion } from '../api'
import { DEFAULT_SESSION_TITLE } from '../constants'
import {
  buildAutoTitleRequest,
  parseAutoTitleResponse,
} from '../lib/title/auto-title'
import type { Message } from '../types'

interface UseAutoSessionTitleOptions {
  enabled: boolean
  sessionId: string | null
  /** Current title; only the untouched default title is replaced. */
  sessionTitle: string
  messages: Message[]
  /** Summary model when set, otherwise the conversation model. */
  model: string
  group: string
  /** True while a reply streams or a comparison runs. */
  isBusy: boolean
  onRename: (sessionId: string, title: string) => void
}

/**
 * Names a conversation after its first completed reply. The title is one
 * ordinary non-streaming `/pg/chat/completions` call (therefore billed and
 * rate limited like any other turn) and is written through the normal rename
 * path, so the existing autosave PATCHes it to the server.
 *
 * Naming is best-effort: a failed or empty answer keeps the old title, and a
 * request is discarded when the conversation changes, the feature is turned
 * off, the user renamed the conversation meanwhile, or the component unmounts.
 */
export function useAutoSessionTitle(options: UseAutoSessionTitleOptions) {
  const controllerRef = useRef<AbortController | null>(null)
  const sequenceRef = useRef(0)
  const wasBusyRef = useRef({
    busy: options.isBusy,
    sessionId: options.sessionId,
  })
  const optionsRef = useRef(options)
  optionsRef.current = options

  const cancel = useCallback(() => {
    sequenceRef.current += 1
    controllerRef.current?.abort()
    controllerRef.current = null
  }, [])

  // A conversation switch or unmount aborts the in-flight title request, and
  // disabling the feature discards a late answer as well.
  useEffect(() => {
    if (!options.enabled) cancel()
  }, [options.enabled, cancel])

  useEffect(() => {
    return () => {
      cancel()
    }
  }, [options.sessionId, cancel])

  useEffect(() => {
    const previous = wasBusyRef.current
    wasBusyRef.current = {
      busy: options.isBusy,
      sessionId: options.sessionId,
    }
    if (
      !previous.busy ||
      options.isBusy ||
      previous.sessionId !== options.sessionId
    ) {
      return
    }

    const current = optionsRef.current
    if (
      !current.enabled ||
      !current.sessionId ||
      current.sessionTitle !== DEFAULT_SESSION_TITLE
    ) {
      return
    }
    const request = buildAutoTitleRequest({
      messages: current.messages,
      model: current.model,
      group: current.group,
    })
    if (!request) return

    const requestSessionId = current.sessionId
    const sequence = sequenceRef.current + 1
    sequenceRef.current = sequence
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller

    void sendChatCompletion(request, controller.signal)
      .then(({ response }) => {
        if (sequence !== sequenceRef.current || controller.signal.aborted)
          return
        const latest = optionsRef.current
        if (
          !latest.enabled ||
          latest.sessionId !== requestSessionId ||
          latest.sessionTitle !== DEFAULT_SESSION_TITLE
        ) {
          return
        }
        const title = parseAutoTitleResponse(
          response.choices?.[0]?.message?.content ?? ''
        )
        if (!title) return
        latest.onRename(requestSessionId, title)
      })
      .catch(() => {
        // Automatic naming never disturbs the conversation. The default title
        // stays in place, so a later completed reply can try again.
      })
      .finally(() => {
        if (sequence === sequenceRef.current) {
          controllerRef.current = null
        }
      })
  }, [options.isBusy, options.sessionId])
}
