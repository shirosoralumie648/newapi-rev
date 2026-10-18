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

import {
  EMPTY_REFERRAL_AGENT_PROFILE,
  getReferralRateSourceLabelKey,
  parseReferralAgentTiersOption,
} from '../referral'

describe('referral agent tier option parsing', () => {
  test('keeps valid tiers and normalizes a stringified rate', () => {
    expect(
      parseReferralAgentTiersOption(
        '[{"id":"bronze","name":"Bronze","rate_percent":40},{"id":"gold","name":"Gold","rate_percent":"60"}]'
      )
    ).toEqual([
      { id: 'bronze', name: 'Bronze', rate_percent: 40 },
      { id: 'gold', name: 'Gold', rate_percent: 60 },
    ])
  })

  test('returns no tiers for malformed JSON or a non-array value', () => {
    expect(parseReferralAgentTiersOption('{not json')).toEqual([])
    expect(parseReferralAgentTiersOption('{"id":"bronze"}')).toEqual([])
  })

  test('skips entries without an identifier, a name or a numeric rate', () => {
    expect(
      parseReferralAgentTiersOption(
        JSON.stringify([
          { id: 'ok', name: 'Ok', rate_percent: 0 },
          { name: 'No id', rate_percent: 10 },
          { id: 'no-name', rate_percent: 10 },
          { id: 'no-rate', name: 'No rate' },
          { id: 'bad-rate', name: 'Bad rate', rate_percent: 'abc' },
          null,
        ])
      )
    ).toEqual([{ id: 'ok', name: 'Ok', rate_percent: 0 }])
  })
})

describe('referral rate source labels', () => {
  test('maps every resolution source to its translation key', () => {
    expect(getReferralRateSourceLabelKey('user')).toBe('Account override')
    expect(getReferralRateSourceLabelKey('tier')).toBe('Agent tier')
    expect(getReferralRateSourceLabelKey('group')).toBe('User group')
    expect(getReferralRateSourceLabelKey('default')).toBe('Global default')
  })

  test('keeps an unknown source recorded by a newer backend readable', () => {
    expect(getReferralRateSourceLabelKey('future')).toBe('future')
  })
})

describe('empty referral agent profile', () => {
  test('starts unmarked on the global default while loading', () => {
    expect(EMPTY_REFERRAL_AGENT_PROFILE.marked).toBe(false)
    expect(EMPTY_REFERRAL_AGENT_PROFILE.rate_source).toBe('default')
    expect(EMPTY_REFERRAL_AGENT_PROFILE.enabled).toBe(false)
  })
})
