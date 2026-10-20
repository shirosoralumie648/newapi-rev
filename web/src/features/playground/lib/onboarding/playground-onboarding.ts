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
import { z } from 'zod'

import { STORAGE_KEYS } from '../../constants'

const ONBOARDING_VERSION = 1

/**
 * Browser-owned onboarding progress of one Playground account. It is a hint
 * for when to show the welcome card and the feature entries, never a source of
 * truth for conversations or canvas data, so a missing or damaged value falls
 * back to the first-visit state.
 */
export interface PlaygroundOnboardingState {
  welcomeSeen: boolean
  tourCompleted: boolean
}

const onboardingSchema = z.object({
  welcomeSeen: z.boolean(),
  tourCompleted: z.boolean(),
})

const DEFAULT_ONBOARDING_STATE: PlaygroundOnboardingState = {
  welcomeSeen: false,
  tourCompleted: false,
}

type StoredEnvelope = { version: number; data: unknown }

function onboardingKey(userId: number): string {
  return `${STORAGE_KEYS.ONBOARDING}:${userId}`
}

export function loadPlaygroundOnboardingState(
  userId: number | null
): PlaygroundOnboardingState {
  if (userId === null || typeof window === 'undefined') {
    return DEFAULT_ONBOARDING_STATE
  }
  try {
    const raw = window.localStorage.getItem(onboardingKey(userId))
    if (!raw) return DEFAULT_ONBOARDING_STATE
    const envelope = JSON.parse(raw) as Partial<StoredEnvelope>
    if (envelope.version !== ONBOARDING_VERSION || !('data' in envelope)) {
      return DEFAULT_ONBOARDING_STATE
    }
    const parsed = onboardingSchema.safeParse(envelope.data)
    return parsed.success ? parsed.data : DEFAULT_ONBOARDING_STATE
  } catch {
    return DEFAULT_ONBOARDING_STATE
  }
}

export function savePlaygroundOnboardingState(
  userId: number | null,
  state: PlaygroundOnboardingState
): boolean {
  if (userId === null || typeof window === 'undefined') return false
  try {
    const payload: StoredEnvelope = {
      version: ONBOARDING_VERSION,
      data: onboardingSchema.parse(state),
    }
    window.localStorage.setItem(onboardingKey(userId), JSON.stringify(payload))
    return true
  } catch {
    return false
  }
}

/**
 * Marking the tour complete is also enough to treat the welcome card as read:
 * a user who finished or replayed the tour has seen what it introduces.
 */
export function markPlaygroundTourCompleted(userId: number | null): void {
  savePlaygroundOnboardingState(userId, {
    welcomeSeen: true,
    tourCompleted: true,
  })
}
