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

import { formatPaymentAmount, getStatusConfig } from '../billing'

describe('topup status configuration', () => {
  test('marks a refunded order as danger with the refunded label', () => {
    expect(getStatusConfig('refunded')).toEqual({
      variant: 'danger',
      label: 'Refunded',
    })
  })

  test('marks a disputed order as danger with the disputed label', () => {
    expect(getStatusConfig('disputed')).toEqual({
      variant: 'danger',
      label: 'Disputed',
    })
  })
})

describe('payment amount formatting', () => {
  test('formats a decimal string in the provider currency', () => {
    const formatted = formatPaymentAmount('12.50', 'usd')

    expect(formatted).toMatch(/12[.,]50/)
    expect(formatted).toMatch(/\$/)
  })

  test('falls back to a plain number for an unknown currency code', () => {
    expect(formatPaymentAmount('12.5', 'US')).toMatch(/12[.,]5/)
    expect(formatPaymentAmount('12.5', 'zzz')).toMatch(/12[.,]5/)
  })

  test('shows a placeholder for a non-numeric amount', () => {
    expect(formatPaymentAmount('not-a-number', 'USD')).toBe('-')
  })
})
