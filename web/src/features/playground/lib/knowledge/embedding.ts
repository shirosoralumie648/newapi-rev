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

const BASE64_CHUNK_SIZE = 0x8000

/** Encode arbitrary bytes as standard padded base64. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_SIZE) {
    const chunk = bytes.subarray(offset, offset + BASE64_CHUNK_SIZE)
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}

/** Encode one ArrayBuffer as standard padded base64. */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  return bytesToBase64(new Uint8Array(buffer))
}

/**
 * Encode one embedding vector as the wire shape the knowledge API accepts:
 * little-endian float32 values in base64. The server validates the byte length
 * against the declared dimensions and rejects NaN or infinite values, so the
 * encoder refuses them before they leave the browser.
 */
export function encodeKnowledgeEmbedding(values: readonly number[]): string {
  if (values.length === 0) {
    throw new Error('An embedding vector must contain at least one value.')
  }
  const buffer = new ArrayBuffer(values.length * 4)
  const view = new DataView(buffer)
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (!Number.isFinite(value)) {
      throw new Error('An embedding vector contains a non-finite value.')
    }
    view.setFloat32(index * 4, value, true)
  }
  return bytesToBase64(new Uint8Array(buffer))
}
