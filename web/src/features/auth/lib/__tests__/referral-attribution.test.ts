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

import { referralAttribution } from '../referral-attribution'

describe('referral attribution', () => {
  test('attributes nothing when the invitation code is empty or blank', () => {
    expect(referralAttribution('', 'Invite123')).toEqual({})
    expect(referralAttribution('   ', '')).toEqual({})
  })

  test('keeps the link channel while the arrived code is unchanged', () => {
    expect(referralAttribution('Invite123', 'Invite123')).toEqual({
      affCode: 'Invite123',
      referralSource: 'link',
    })
    expect(referralAttribution(' Invite123 ', 'Invite123')).toEqual({
      affCode: 'Invite123',
      referralSource: 'link',
    })
  })

  test('marks an edited or hand-entered code as the code channel', () => {
    expect(referralAttribution('Typed456', 'Invite123')).toEqual({
      affCode: 'Typed456',
      referralSource: 'code',
    })
    expect(referralAttribution('Typed456', '')).toEqual({
      affCode: 'Typed456',
      referralSource: 'code',
    })
  })
})
