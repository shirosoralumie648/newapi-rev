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
import { useCallback, useEffect, useRef, useState } from 'react'

import { PLAYGROUND_AUDIO_VOICES } from '../constants'
import { submitAudioSpeech } from '../generation-api'

interface UseAutoReadAloudOptions {
  enabled: boolean
  sessionId: string | null
  /** Speech model; the workspace passes the same default the dialog uses. */
  model: string
  group: string
}

interface ActivePlayback {
  audio: HTMLAudioElement
  url: string
}

/**
 * Reads a finished reply aloud through the existing `/pg/audio/speech` relay
 * route. The call is fire-and-forget: it never disables the composer and every
 * playback step is guarded by a sequence number, so a reply that arrives after
 * the session changed (or after a newer reply started) is discarded instead of
 * played. Failures are silent — the next reply simply tries again.
 */
export function useAutoReadAloud(options: UseAutoReadAloudOptions) {
  const [isReading, setIsReading] = useState(false)
  const sequenceRef = useRef(0)
  const controllerRef = useRef<AbortController | null>(null)
  const playbackRef = useRef<ActivePlayback | null>(null)
  const sessionRef = useRef(options.sessionId)
  const optionsRef = useRef(options)
  optionsRef.current = options
  sessionRef.current = options.sessionId

  const releasePlayback = useCallback(() => {
    const playback = playbackRef.current
    playbackRef.current = null
    if (!playback) return
    playback.audio.pause()
    URL.revokeObjectURL(playback.url)
  }, [])

  const stop = useCallback(() => {
    sequenceRef.current += 1
    controllerRef.current?.abort()
    controllerRef.current = null
    releasePlayback()
    setIsReading(false)
  }, [releasePlayback])

  // A conversation switch or unmount stops the current take: the audio of one
  // conversation must never keep playing over another.
  useEffect(() => {
    return () => {
      stop()
    }
  }, [options.sessionId, stop])

  const read = useCallback(
    (text: string) => {
      const current = optionsRef.current
      const trimmed = text.trim()
      if (
        !current.enabled ||
        !current.sessionId ||
        !current.model.trim() ||
        !trimmed
      ) {
        return
      }

      const sequence = sequenceRef.current + 1
      const requestSessionId = current.sessionId
      sequenceRef.current = sequence
      controllerRef.current?.abort()
      releasePlayback()
      const controller = new AbortController()
      controllerRef.current = controller
      setIsReading(true)

      void submitAudioSpeech(
        {
          model: current.model.trim(),
          text: trimmed,
          group: current.group,
          voice: PLAYGROUND_AUDIO_VOICES[0],
        },
        controller.signal
      )
        .then((blob) => {
          if (
            sequence !== sequenceRef.current ||
            controller.signal.aborted ||
            sessionRef.current !== requestSessionId
          ) {
            return
          }
          const url = URL.createObjectURL(blob)
          const audio = new Audio(url)
          playbackRef.current = { audio, url }
          audio.addEventListener(
            'ended',
            () => {
              if (playbackRef.current?.url === url) {
                releasePlayback()
                setIsReading(false)
              }
            },
            { once: true }
          )
          // Autoplay policies may reject playback before any user gesture;
          // that is not an error worth surfacing for an automatic feature.
          void audio.play().catch(() => {
            if (playbackRef.current?.url === url) {
              releasePlayback()
              setIsReading(false)
            }
          })
        })
        .catch(() => {
          // A failed generation leaves nothing to read; a newer reply or a
          // session switch has already taken over this state otherwise.
          if (sequence === sequenceRef.current) {
            setIsReading(false)
          }
        })
        .finally(() => {
          if (sequence === sequenceRef.current) {
            controllerRef.current = null
          }
        })
    },
    [releasePlayback]
  )

  return { read, stop, isReading }
}
