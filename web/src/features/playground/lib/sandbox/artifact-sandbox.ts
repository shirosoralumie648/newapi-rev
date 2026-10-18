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
// The sandboxed artifact preview runs untrusted model output in an iframe that
// shares nothing with this site: an opaque origin (the sandbox token set below
// deliberately omits `allow-same-origin`) plus a document-level CSP that denies
// every network and embedding primitive. Content can only run its own inline
// script and style, and it can only talk back through the two whitelisted
// message types this module parses.
export type PlaygroundSandboxArtifactKind = 'html' | 'svg'

/**
 * The exact `sandbox` token set for the artifact iframe. `allow-scripts` lets a
 * self-contained artifact initialize; `allow-same-origin`, navigation, popups,
 * forms and downloads stay absent so the document cannot reach this origin,
 * this site's storage, or any top-level context.
 */
export const PLAYGROUND_ARTIFACT_IFRAME_SANDBOX = 'allow-scripts'

/**
 * Permissions-Policy denials for the artifact iframe. Every powerful feature an
 * embedded page could otherwise request is explicitly turned off.
 */
export const PLAYGROUND_ARTIFACT_IFRAME_ALLOW = [
  'accelerometer',
  'ambient-light-sensor',
  'autoplay',
  'battery',
  'camera',
  'clipboard-read',
  'clipboard-write',
  'cross-origin-isolated',
  'display-capture',
  'document-domain',
  'encrypted-media',
  'fullscreen',
  'gamepad',
  'geolocation',
  'gyroscope',
  'hid',
  'idle-detection',
  'magnetometer',
  'microphone',
  'midi',
  'otp-credentials',
  'payment',
  'picture-in-picture',
  'publickey-credentials-get',
  'screen-wake-lock',
  'serial',
  'speaker-selection',
  'usb',
  'web-share',
  'xr-spatial-tracking',
]
  .map((feature) => `${feature} 'none'`)
  .join('; ')

/**
 * The document-level CSP injected as the first meta of the sandbox document.
 * `default-src 'none'` denies every fetch, embedding and navigation fallback;
 * only inline script/style and data:/blob: images stay addressable, so an
 * artifact can render but can never reach the network or load an external file.
 */
export const PLAYGROUND_ARTIFACT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "worker-src 'none'",
].join('; ')

/** Message types the sandboxed document may send to this window. */
export const PLAYGROUND_ARTIFACT_SANDBOX_READY =
  'playground-artifact-sandbox:ready'
export const PLAYGROUND_ARTIFACT_SANDBOX_RESIZE =
  'playground-artifact-sandbox:resize'

/** The reported content height is clamped to this ceiling before use. */
export const PLAYGROUND_ARTIFACT_SANDBOX_MAX_HEIGHT = 4000

export type PlaygroundArtifactSandboxMessage =
  | { type: 'ready' }
  | { type: 'resize'; height: number }

const SVG_ROOT_TAG = /<svg[\s>]/i

// A fragment such as `<circle r="4"/>` has no SVG root, so it is wrapped to
// render as the vector document the author intended.
function wrapSvgFragment(content: string): string {
  if (SVG_ROOT_TAG.test(content)) return content
  return `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">${content}</svg>`
}

// The reporter runs inside the sandbox and only reports readiness and size. It
// never reads the parent: messages are validated again on this side by source,
// origin and whitelisted type, and a spoofed height cannot exceed the clamp.
const PLAYGROUND_ARTIFACT_SANDBOX_REPORTER = `(function () {
  function post(payload) {
    try {
      parent.postMessage(payload, '*')
    } catch (error) {
      // A detached frame has no parent to report to.
    }
  }
  function sendHeight() {
    var root = document.documentElement
    var height = Math.max(
      root.scrollHeight,
      root.offsetHeight,
      document.body ? document.body.scrollHeight : 0
    )
    if (height > 0) {
      post({ type: '${PLAYGROUND_ARTIFACT_SANDBOX_RESIZE}', height: height })
    }
  }
  function announce() {
    post({ type: '${PLAYGROUND_ARTIFACT_SANDBOX_READY}' })
    sendHeight()
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', announce)
  } else {
    announce()
  }
  window.addEventListener('load', sendHeight)
  window.addEventListener('resize', sendHeight)
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(sendHeight).observe(document.documentElement)
  }
})()`

// Attribute characters that would otherwise terminate the CSP meta or the
// wrapper markup if they ever appeared in a constant above.
function escapeSandboxAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')
}

/**
 * Builds the sandbox document for one artifact version. The CSP meta is emitted
 * before any artifact markup, and the artifact body is inserted verbatim: the
 * isolation comes from the iframe sandbox and this policy, never from mutating
 * the author's content.
 */
export function buildArtifactSandboxDocument(
  kind: PlaygroundSandboxArtifactKind,
  content: string
): string {
  const body = kind === 'svg' ? wrapSvgFragment(content) : content
  return [
    '<!doctype html>',
    '<html>',
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${escapeSandboxAttribute(PLAYGROUND_ARTIFACT_CSP)}">`,
    '<meta name="referrer" content="no-referrer">',
    '<style>html{color-scheme:light dark}body{margin:0}</style>',
    `<script>${PLAYGROUND_ARTIFACT_SANDBOX_REPORTER}</script>`,
    '</head>',
    '<body>',
    body,
    '</body>',
    '</html>',
  ].join('')
}

/**
 * Validates an inbound message event against the artifact iframe. Only a
 * message whose source is exactly this iframe's content window, whose origin is
 * the opaque `null` origin the sandbox produces, and whose type is one of the
 * two whitelisted types is accepted. Resize heights are rounded and clamped.
 */
export function parsePlaygroundArtifactSandboxMessage(
  event: Pick<MessageEvent, 'data' | 'origin' | 'source'>,
  frame: HTMLIFrameElement | null
): PlaygroundArtifactSandboxMessage | null {
  if (!frame || event.source !== frame.contentWindow) return null
  if (event.origin !== 'null') return null
  const data = event.data
  if (typeof data !== 'object' || data === null) return null
  const type = (data as { type?: unknown }).type
  if (type === PLAYGROUND_ARTIFACT_SANDBOX_READY) return { type: 'ready' }
  if (type !== PLAYGROUND_ARTIFACT_SANDBOX_RESIZE) return null
  const height = (data as { height?: unknown }).height
  if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0) {
    return null
  }
  return {
    type: 'resize',
    height: Math.min(
      Math.round(height),
      PLAYGROUND_ARTIFACT_SANDBOX_MAX_HEIGHT
    ),
  }
}
