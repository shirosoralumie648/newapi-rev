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
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  redeemTopupCode: vi.fn(),
  getSelf: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock('../../api', () => ({ redeemTopupCode: mocks.redeemTopupCode }))
vi.mock('@/lib/api', () => ({ getSelf: mocks.getSelf }))
vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}))

const { useRedemption } = await import('../use-redemption')

describe('redemption result feedback', () => {
  beforeEach(() => {
    mocks.redeemTopupCode.mockReset()
    mocks.getSelf.mockReset()
    mocks.toastSuccess.mockReset()
    mocks.toastError.mockReset()
    mocks.getSelf.mockResolvedValue(undefined)
  })

  test('reports the credited quota for a quota code', async () => {
    mocks.redeemTopupCode.mockResolvedValue({
      success: true,
      data: {
        type: 'quota',
        quota: 500000,
        plan_id: 0,
        plan_title: '',
        subscription_id: 0,
        end_time: 0,
      },
    })

    const { result } = renderHook(() => useRedemption())
    await expect(result.current.redeemCode('code-1')).resolves.toBe(true)

    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      expect.stringContaining('Redemption successful! Added:')
    )
    expect(mocks.getSelf).toHaveBeenCalled()
  })

  test('reports the activated plan for a subscription code', async () => {
    mocks.redeemTopupCode.mockResolvedValue({
      success: true,
      data: {
        type: 'subscription',
        quota: 0,
        plan_id: 7,
        plan_title: 'Pro plan',
        subscription_id: 21,
        end_time: 0,
      },
    })

    const { result } = renderHook(() => useRedemption())
    await expect(result.current.redeemCode('code-2')).resolves.toBe(true)

    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      expect.stringContaining('Redemption successful! Activated subscription:')
    )
    expect(mocks.getSelf).toHaveBeenCalled()
  })

  test('reports a failed redemption without refreshing the account', async () => {
    mocks.redeemTopupCode.mockResolvedValue({
      success: false,
      message: 'Redemption failed, please try again later',
    })

    const { result } = renderHook(() => useRedemption())
    await expect(result.current.redeemCode('code-3')).resolves.toBe(false)

    expect(mocks.toastError).toHaveBeenCalledWith(
      'Redemption failed, please try again later'
    )
    expect(mocks.getSelf).not.toHaveBeenCalled()
  })
})
