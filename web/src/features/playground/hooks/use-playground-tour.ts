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
import 'driver.js/dist/driver.css'
import type { Driver } from 'driver.js'
import { useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { useIsMobile } from '@/hooks/use-mobile'

import {
  buildCanvasTourSteps,
  buildConversationTourSteps,
} from '../lib/onboarding/playground-tour'

type PlaygroundTourKind = 'conversation' | 'canvas'

interface PlaygroundTourOptions {
  /** Called for every user-driven end, including Escape or the close button. */
  onEnd?: (completed: boolean) => void
  /** Called only when the last step's done button was pressed. */
  onComplete?: () => void
}

/**
 * Driver.js-backed onboarding tour. The library is loaded only when a tour
 * starts (its stylesheet stays in the feature chunk), and every start replaces
 * the active tour so two overlays can never compete for focus. Escape, the
 * close button and an overlay click all end the tour.
 */
export function usePlaygroundTour() {
  const { t } = useTranslation()
  const isMobile = useIsMobile()
  const tourRef = useRef<Driver | null>(null)
  const requestIdRef = useRef(0)

  useEffect(() => {
    return () => {
      requestIdRef.current += 1
      tourRef.current?.destroy()
      tourRef.current = null
    }
  }, [])

  const startTour = useCallback(
    (kind: PlaygroundTourKind, options: PlaygroundTourOptions = {}) => {
      const requestId = ++requestIdRef.current
      tourRef.current?.destroy()
      tourRef.current = null

      void import('driver.js')
        .then(({ driver: createDriver }) => {
          if (requestId !== requestIdRef.current) return
          const steps =
            kind === 'conversation'
              ? buildConversationTourSteps(t, isMobile)
              : buildCanvasTourSteps(t, isMobile)
          let tour: Driver
          tour = createDriver({
            steps,
            animate: true,
            smoothScroll: true,
            allowClose: true,
            allowKeyboardControl: true,
            overlayClickBehavior: 'close',
            skipMissingElement: true,
            showProgress: true,
            progressText: t('{{current}} of {{total}}'),
            nextBtnText: t('Next'),
            prevBtnText: t('Back'),
            doneBtnText: t('Done'),
            closeBtnLabel: t('Close guide'),
            popoverClass: 'playground-tour-popover',
            onDestroyed: (_element, _step, opts) => {
              if (tourRef.current !== tour) return
              tourRef.current = null
              if (opts.reason === 'api' || opts.reason === 'replaced') return
              const completed = opts.reason === 'done'
              options.onEnd?.(completed)
              if (completed) options.onComplete?.()
            },
          })
          tourRef.current = tour
          tour.drive()
        })
        .catch(() => {
          // A failed optional chunk load must not interrupt the Playground.
        })
    },
    [isMobile, t]
  )

  return { startTour }
}
