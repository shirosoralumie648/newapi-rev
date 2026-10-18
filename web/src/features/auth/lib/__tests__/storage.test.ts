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
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { getDeviceId } from '../storage'

describe('auth storage device identifier', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  test('generates one device id and keeps returning the persisted value', () => {
    const deviceId = getDeviceId()

    expect(deviceId).toMatch(/^[0-9a-f-]{32,36}$/)
    expect(window.localStorage.getItem('device_id')).toBe(deviceId)
    expect(getDeviceId()).toBe(deviceId)
  })

  test('reuses a device id that is already persisted', () => {
    window.localStorage.setItem('device_id', 'stored-device-id')

    expect(getDeviceId()).toBe('stored-device-id')
    expect(window.localStorage.getItem('device_id')).toBe('stored-device-id')
  })

  test('degrades to no device id when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage denied')
    })

    expect(getDeviceId()).toBe('')
  })
})
