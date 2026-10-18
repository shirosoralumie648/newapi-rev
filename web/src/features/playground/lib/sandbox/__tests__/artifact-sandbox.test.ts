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
  buildArtifactSandboxDocument,
  parsePlaygroundArtifactSandboxMessage,
  PLAYGROUND_ARTIFACT_CSP,
  PLAYGROUND_ARTIFACT_IFRAME_ALLOW,
  PLAYGROUND_ARTIFACT_IFRAME_SANDBOX,
  PLAYGROUND_ARTIFACT_SANDBOX_MAX_HEIGHT,
  PLAYGROUND_ARTIFACT_SANDBOX_READY,
  PLAYGROUND_ARTIFACT_SANDBOX_RESIZE,
} from '../artifact-sandbox'

function stubFrame() {
  const frame = { contentWindow: {} }
  return frame as unknown as HTMLIFrameElement
}

function messageEvent(
  data: unknown,
  origin: string,
  source: unknown
): Pick<MessageEvent, 'data' | 'origin' | 'source'> {
  return { data, origin, source } as Pick<
    MessageEvent,
    'data' | 'origin' | 'source'
  >
}

describe('artifact iframe hardening constants', () => {
  test('the sandbox token set allows scripts but never same-origin access', () => {
    expect(PLAYGROUND_ARTIFACT_IFRAME_SANDBOX).toBe('allow-scripts')
    expect(PLAYGROUND_ARTIFACT_IFRAME_SANDBOX).not.toContain(
      'allow-same-origin'
    )
    expect(PLAYGROUND_ARTIFACT_IFRAME_SANDBOX).not.toContain(
      'allow-top-navigation'
    )
    expect(PLAYGROUND_ARTIFACT_IFRAME_SANDBOX).not.toContain('allow-popups')
    expect(PLAYGROUND_ARTIFACT_IFRAME_SANDBOX).not.toContain('allow-forms')
  })

  test('every powerful iframe feature is explicitly denied', () => {
    for (const feature of [
      'camera',
      'geolocation',
      'microphone',
      'clipboard-read',
      'clipboard-write',
      'usb',
    ]) {
      expect(PLAYGROUND_ARTIFACT_IFRAME_ALLOW).toContain(`${feature} 'none'`)
    }
  })
})

describe('buildArtifactSandboxDocument', () => {
  test('the CSP meta comes before the artifact body and denies network access', () => {
    const document = buildArtifactSandboxDocument(
      'html',
      '<p id="artifact">hello</p>'
    )
    const cspIndex = document.indexOf('Content-Security-Policy')
    const bodyIndex = document.indexOf('<p id="artifact">hello</p>')
    expect(cspIndex).toBeGreaterThan(-1)
    expect(bodyIndex).toBeGreaterThan(cspIndex)
    expect(PLAYGROUND_ARTIFACT_CSP).toContain("default-src 'none'")
    expect(PLAYGROUND_ARTIFACT_CSP).toContain("connect-src 'none'")
    expect(PLAYGROUND_ARTIFACT_CSP).toContain("form-action 'none'")
    expect(PLAYGROUND_ARTIFACT_CSP).toContain("object-src 'none'")
    expect(PLAYGROUND_ARTIFACT_CSP).toContain("frame-src 'none'")
  })

  test('html content is embedded verbatim without escaping the author markup', () => {
    const content = '<div onclick="void 0">&amp; <em>kept</em></div>'
    const document = buildArtifactSandboxDocument('html', content)
    expect(document).toContain(content)
  })

  test('an svg document with its own root is not wrapped again', () => {
    const content = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'
    const document = buildArtifactSandboxDocument('svg', content)
    expect(document).toContain(content)
    expect(document.match(/<svg/g)).toHaveLength(1)
  })

  test('an svg fragment is wrapped in a renderable svg root', () => {
    const document = buildArtifactSandboxDocument(
      'svg',
      '<circle cx="4" cy="4" r="4"/>'
    )
    expect(document).toContain(
      '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%"><circle cx="4" cy="4" r="4"/></svg>'
    )
  })
})

describe('parsePlaygroundArtifactSandboxMessage', () => {
  test('rejects a message when there is no frame', () => {
    const frame = stubFrame()
    const event = messageEvent(
      { type: PLAYGROUND_ARTIFACT_SANDBOX_READY },
      'null',
      frame.contentWindow
    )
    expect(parsePlaygroundArtifactSandboxMessage(event, null)).toBeNull()
  })

  test('rejects a message sent by a different window', () => {
    const frame = stubFrame()
    const event = messageEvent(
      { type: PLAYGROUND_ARTIFACT_SANDBOX_READY },
      'null',
      {}
    )
    expect(parsePlaygroundArtifactSandboxMessage(event, frame)).toBeNull()
  })

  test('rejects a message from an origin other than the opaque null origin', () => {
    const frame = stubFrame()
    const event = messageEvent(
      { type: PLAYGROUND_ARTIFACT_SANDBOX_READY },
      'https://example.com',
      frame.contentWindow
    )
    expect(parsePlaygroundArtifactSandboxMessage(event, frame)).toBeNull()
  })

  test('rejects message types outside the whitelist', () => {
    const frame = stubFrame()
    for (const type of ['navigate', 'playground-artifact-sandbox:command', 7]) {
      const event = messageEvent({ type }, 'null', frame.contentWindow)
      expect(parsePlaygroundArtifactSandboxMessage(event, frame)).toBeNull()
    }
  })

  test('accepts the ready message from the frame itself', () => {
    const frame = stubFrame()
    const event = messageEvent(
      { type: PLAYGROUND_ARTIFACT_SANDBOX_READY },
      'null',
      frame.contentWindow
    )
    expect(parsePlaygroundArtifactSandboxMessage(event, frame)).toEqual({
      type: 'ready',
    })
  })

  test('resize heights are rounded and clamped to the ceiling', () => {
    const frame = stubFrame()
    const resize = (height: unknown) =>
      parsePlaygroundArtifactSandboxMessage(
        messageEvent(
          { type: PLAYGROUND_ARTIFACT_SANDBOX_RESIZE, height },
          'null',
          frame.contentWindow
        ),
        frame
      )
    expect(resize(320.6)).toEqual({ type: 'resize', height: 321 })
    expect(resize(PLAYGROUND_ARTIFACT_SANDBOX_MAX_HEIGHT + 5000)).toEqual({
      type: 'resize',
      height: PLAYGROUND_ARTIFACT_SANDBOX_MAX_HEIGHT,
    })
  })

  test('resize messages with unusable heights are dropped', () => {
    const frame = stubFrame()
    const resize = (height: unknown) =>
      parsePlaygroundArtifactSandboxMessage(
        messageEvent(
          { type: PLAYGROUND_ARTIFACT_SANDBOX_RESIZE, height },
          'null',
          frame.contentWindow
        ),
        frame
      )
    for (const height of [
      0,
      -20,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '300',
    ]) {
      expect(resize(height)).toBeNull()
    }
  })
})
