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
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  buildArtifactSandboxDocument,
  parsePlaygroundArtifactSandboxMessage,
  PLAYGROUND_ARTIFACT_IFRAME_ALLOW,
  PLAYGROUND_ARTIFACT_IFRAME_SANDBOX,
  type PlaygroundSandboxArtifactKind,
} from '../../lib/sandbox/artifact-sandbox'

interface SandboxedArtifactPreviewProps {
  kind: PlaygroundSandboxArtifactKind
  title: string
  content: string
  /**
   * The server-side switch value. When it is false the preview renders nothing,
   * so artifact content can never reach the sandbox without the administrator
   * opt-in. It defaults to false at every call site that cannot prove otherwise.
   */
  sandboxEnabled: boolean
}

/**
 * Renders one artifact version inside the locked-down artifact iframe. The
 * document is supplied through `srcDoc` (an opaque origin document: no URL, no
 * cookies, no same-origin access) and the iframe keeps only `allow-scripts`
 * plus an explicit Permissions-Policy denial list. The only inbound channel is
 * the whitelisted resize/ready message parsed below.
 */
export function SandboxedArtifactPreview(props: SandboxedArtifactPreviewProps) {
  const { t } = useTranslation()
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const [height, setHeight] = useState<number | null>(null)

  useEffect(() => {
    if (!props.sandboxEnabled) return
    const handleMessage = (event: MessageEvent) => {
      const message = parsePlaygroundArtifactSandboxMessage(
        event,
        frameRef.current
      )
      if (message?.type === 'resize') setHeight(message.height)
    }
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [props.sandboxEnabled])

  if (!props.sandboxEnabled) return null

  return (
    <iframe
      ref={frameRef}
      allow={PLAYGROUND_ARTIFACT_IFRAME_ALLOW}
      className={
        height === null
          ? 'h-96 w-full min-w-0 rounded-md border bg-white'
          : 'w-full min-w-0 rounded-md border bg-white'
      }
      referrerPolicy='no-referrer'
      sandbox={PLAYGROUND_ARTIFACT_IFRAME_SANDBOX}
      srcDoc={buildArtifactSandboxDocument(props.kind, props.content)}
      style={height === null ? undefined : { height }}
      title={t('Sandboxed artifact preview')}
    />
  )
}
