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
import { expect, test } from 'vitest'

import {
  canvasNodeSourceTarget,
  canvasSourceSearch,
} from '../canvas-navigation'

test('resolves a source target for message nodes', () => {
  expect(
    canvasNodeSourceTarget({ sessionId: 'pgs_1', messageKey: 'm1' })
  ).toEqual({ sessionId: 'pgs_1', messageKey: 'm1' })
})

test('resolves a source target that also carries an artifact', () => {
  expect(
    canvasNodeSourceTarget({ sessionId: 'pgs_1', artifactId: 'a1' })
  ).toEqual({ sessionId: 'pgs_1', artifactId: 'a1' })
})

test('returns no target for content-only nodes', () => {
  expect(canvasNodeSourceTarget({ messageKey: 'm1' })).toBeNull()
  expect(canvasNodeSourceTarget(undefined)).toBeNull()
})

test('maps a target to playground search params', () => {
  expect(canvasSourceSearch({ sessionId: 'pgs_1' })).toEqual({
    session: 'pgs_1',
  })
  expect(
    canvasSourceSearch({ sessionId: 'pgs_1', messageKey: 'm1' })
  ).toEqual({ session: 'pgs_1', message: 'm1' })
  expect(
    canvasSourceSearch({ sessionId: 'pgs_1', artifactId: 'a1' })
  ).toEqual({ session: 'pgs_1', artifact: 'a1' })
})
