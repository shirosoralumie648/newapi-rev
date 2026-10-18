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
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getAffiliateCode: vi.fn(),
  transferAffiliateQuota: vi.fn(),
  getSelf: vi.fn(),
  copyToClipboard: vi.fn(),
  toastSuccess: vi.fn(),
}))

vi.mock('../../api', () => ({
  getAffiliateCode: mocks.getAffiliateCode,
  transferAffiliateQuota: mocks.transferAffiliateQuota,
}))
vi.mock('@/lib/api', () => ({ getSelf: mocks.getSelf }))
vi.mock('@/hooks/use-copy-to-clipboard', () => ({
  useCopyToClipboard: () => ({ copyToClipboard: mocks.copyToClipboard }),
}))
vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: vi.fn() },
}))

const { useAffiliate } = await import('../use-affiliate')

describe('affiliate quota transfer', () => {
  beforeEach(() => {
    mocks.getAffiliateCode.mockReset()
    mocks.transferAffiliateQuota.mockReset()
    mocks.getSelf.mockReset()
    mocks.copyToClipboard.mockReset()
    mocks.toastSuccess.mockReset()
    mocks.getAffiliateCode.mockResolvedValue({
      success: true,
      data: 'aff-code',
    })
    mocks.transferAffiliateQuota.mockResolvedValue({ success: true })
    mocks.getSelf.mockResolvedValue(undefined)
  })

  test('posts a fresh idempotency key with every transfer attempt', async () => {
    const { result } = renderHook(() => useAffiliate())
    await waitFor(() => expect(mocks.getAffiliateCode).toHaveBeenCalled())

    await expect(result.current.transferQuota(500)).resolves.toBe(true)
    await expect(result.current.transferQuota(500)).resolves.toBe(true)

    expect(mocks.transferAffiliateQuota).toHaveBeenCalledTimes(2)
    const first = mocks.transferAffiliateQuota.mock.calls[0][0]
    const second = mocks.transferAffiliateQuota.mock.calls[1][0]
    expect(first).toMatchObject({ quota: 500 })
    expect(typeof first.request_id).toBe('string')
    expect(first.request_id.length).toBeGreaterThan(0)
    // Each attempt carries its own key, so the server can tell a retry of one
    // attempt from a genuinely new transfer.
    expect(second.request_id).not.toBe(first.request_id)
    expect(mocks.getSelf).toHaveBeenCalledTimes(2)
  })

  test('reports a refused transfer without refreshing the account', async () => {
    mocks.transferAffiliateQuota.mockResolvedValue({
      success: false,
      message: 'Invitation quota is insufficient!',
    })

    const { result } = renderHook(() => useAffiliate())
    await waitFor(() => expect(mocks.getAffiliateCode).toHaveBeenCalled())

    await expect(result.current.transferQuota(500)).resolves.toBe(false)
    expect(mocks.getSelf).not.toHaveBeenCalled()
  })
})
