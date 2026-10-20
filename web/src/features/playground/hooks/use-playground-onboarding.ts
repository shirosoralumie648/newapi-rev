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
import { useCallback, useEffect, useState } from 'react'

import {
  loadPlaygroundOnboardingState,
  savePlaygroundOnboardingState,
  type PlaygroundOnboardingState,
} from '../lib/onboarding/playground-onboarding'

/**
 * First-visit state of the Playground. The welcome card opens once per account
 * until it is dismissed; Help can reopen it without changing that record.
 * Feature entries stay in the empty state until the tour is completed.
 */
export function usePlaygroundOnboarding(userId: number | null) {
  const [state, setState] = useState<PlaygroundOnboardingState>(() =>
    loadPlaygroundOnboardingState(userId)
  )
  const [welcomeOpen, setWelcomeOpen] = useState(false)

  useEffect(() => {
    // Switching accounts swaps the per-account record before deciding whether
    // to reopen the welcome card. Reading the fresh record here avoids briefly
    // showing the previous account's state.
    const next = loadPlaygroundOnboardingState(userId)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState(next)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setWelcomeOpen(userId !== null && !next.welcomeSeen)
  }, [userId])

  const persist = useCallback(
    (next: PlaygroundOnboardingState) => {
      setState(next)
      savePlaygroundOnboardingState(userId, next)
    },
    [userId]
  )

  const dismissWelcome = useCallback(() => {
    setWelcomeOpen(false)
    if (state.welcomeSeen) return
    persist({ ...state, welcomeSeen: true })
  }, [persist, state])

  const handleWelcomeOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        setWelcomeOpen(true)
        return
      }
      dismissWelcome()
    },
    [dismissWelcome]
  )

  const replayWelcome = useCallback(() => {
    setWelcomeOpen(true)
  }, [])

  const completeTour = useCallback(() => {
    if (state.welcomeSeen && state.tourCompleted) return
    persist({ welcomeSeen: true, tourCompleted: true })
  }, [persist, state.tourCompleted, state.welcomeSeen])

  return {
    welcomeOpen,
    isNewcomer: !state.welcomeSeen || !state.tourCompleted,
    dismissWelcome,
    replayWelcome,
    completeTour,
    handleWelcomeOpenChange,
  }
}
