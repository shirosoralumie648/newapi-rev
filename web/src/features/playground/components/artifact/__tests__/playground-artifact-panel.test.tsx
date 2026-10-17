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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'
import { useAuthStore } from '@/stores/auth-store'

import type {
  PlaygroundArtifactKind,
  PlaygroundArtifactResult,
  PlaygroundArtifactSummary,
} from '../../../artifact-api'
import { usePlaygroundArtifacts } from '../../../hooks/use-playground-artifacts'
import { PlaygroundArtifactPanel } from '../playground-artifact-panel'

Object.defineProperty(HTMLElement.prototype, 'getAnimations', {
  configurable: true,
  value: () => [],
})

const SESSION = 'pgs_session'
const ARTIFACT_PATH = `/api/playground/sessions/${SESSION}/artifacts`
const onClose = vi.fn()

interface ArtifactFixture {
  content: string
  id: string
  kind: PlaygroundArtifactKind
  language: string
  title: string
}

const fixtures: ArtifactFixture[] = [
  {
    content: 'First content',
    id: 'pga_first',
    kind: 'markdown',
    language: 'markdown',
    title: 'Document One',
  },
  {
    content: 'Second content',
    id: 'pga_second',
    kind: 'markdown',
    language: 'markdown',
    title: 'Document Two',
  },
  {
    // Raw HTML, an event handler and a javascript: link must all be inert after
    // the Markdown preview renders this through the sanitizing chain.
    content: [
      '# Unsafe answer',
      '',
      '<script>window.__artifactXss = true</script>',
      '<img src="x" onerror="window.__artifactXss = true">',
      '',
      '[leak](javascript:window.__artifactXss=true)',
    ].join('\n'),
    id: 'pga_unsafe',
    kind: 'markdown',
    language: 'markdown',
    title: 'Unsafe Document',
  },
  {
    // A code artifact keeps the same markup as literal text, never as nodes.
    content: [
      'const payload = "<script>window.__artifactXss = true</script>"',
      '<img src="x" onerror="window.__artifactXss = true">',
    ].join('\n'),
    id: 'pga_code',
    kind: 'code',
    language: 'html',
    title: 'Executable Code',
  },
  {
    content: 'Report body',
    id: 'pga_download',
    kind: 'markdown',
    language: 'markdown',
    title: 'Report: <draft>/final?',
  },
  {
    content: 'plain text body',
    id: 'pga_plain',
    kind: 'code',
    language: 'plaintext',
    title: 'Plain Snippet',
  },
]

interface CapturedDownload {
  blob: Blob
  filename: string
}

function captureDownloads(): CapturedDownload[] {
  const downloads: CapturedDownload[] = []
  let currentBlob: Blob | null = null
  vi.stubGlobal(
    'URL',
    Object.assign(class extends URL {}, {
      createObjectURL: (blob: Blob) => {
        currentBlob = blob
        return 'blob:playground-artifact'
      },
      revokeObjectURL: () => undefined,
    })
  )
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(
    function (this: HTMLAnchorElement) {
      if (currentBlob) {
        downloads.push({ blob: currentBlob, filename: this.download })
      }
    }
  )
  return downloads
}

function makeResult(fixture: ArtifactFixture): PlaygroundArtifactResult {
  return {
    artifact: {
      id: fixture.id,
      session_id: SESSION,
      kind: fixture.kind,
      revision: 1,
      current_version_id: `${fixture.id}_v1`,
      title: fixture.title,
      language: fixture.language,
      created_at: 1,
      updated_at: 1,
    },
    version: {
      id: `${fixture.id}_v1`,
      artifact_id: fixture.id,
      number: 1,
      title: fixture.title,
      language: fixture.language,
      content: fixture.content,
      byte_size: fixture.content.length,
      created_at: 1,
    },
  }
}

function Harness(props: {
  onSendToCanvas?: (artifact: PlaygroundArtifactSummary) => void
}) {
  const controller = usePlaygroundArtifacts(7, SESSION)
  return (
    <PlaygroundArtifactPanel
      controller={controller}
      onClose={onClose}
      onSendToCanvas={props.onSendToCanvas}
    />
  )
}

beforeEach(() => {
  localStorage.clear()
  onClose.mockClear()
  useAuthStore.getState().auth.setUser({ id: 7, username: 'user', role: 1 })

  const results = new Map<string, PlaygroundArtifactResult>(
    fixtures.map(
      (fixture) => [fixture.id, makeResult(fixture)] as const
    )
  )
  vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url === ARTIFACT_PATH) {
      return {
        data: {
          success: true,
          data: {
            items: fixtures.map((fixture) => results.get(fixture.id)?.artifact),
            total: fixtures.length,
            page: 1,
            page_size: 50,
          },
        },
      }
    }
    const parts = url.split('/')
    const isVersions = url.endsWith('/versions')
    const id = isVersions ? parts.at(-2) : parts.at(-1)
    if (!id) {
      throw new Error(`Unexpected URL in test: ${url}`)
    }
    const result = results.get(id)
    if (isVersions) {
      return {
        data: {
          success: true,
          data: {
            items: result
              ? [
                  {
                    id: result.version.id,
                    artifact_id: id,
                    number: result.version.number,
                    title: result.version.title,
                    language: result.version.language,
                    byte_size: result.version.byte_size,
                    created_at: 1,
                  },
                ]
              : [],
            total: result ? 1 : 0,
            page: 1,
            page_size: 50,
          },
        },
      }
    }
    if (!result) {
      throw new Error(`Unexpected artifact id in test: ${id}`)
    }
    return { data: { success: true, data: result } }
  })
})

afterEach(() => {
  cleanup()
  useAuthStore.getState().auth.reset()
  localStorage.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function renderPanel(
  onSendToCanvas?: (artifact: PlaygroundArtifactSummary) => void
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const view = render(
    <QueryClientProvider client={client}>
      <Harness onSendToCanvas={onSendToCanvas} />
    </QueryClientProvider>
  )
  return view.container
}

test('switching artifacts with unsaved changes asks before discarding', async () => {
  const user = userEvent.setup()
  renderPanel()

  await user.click(await screen.findByRole('button', { name: /Document One/ }))
  const titleInput = await screen.findByRole('textbox', {
    name: 'Artifact title',
  })
  expect(titleInput).toHaveValue('Document One')

  await user.clear(titleInput)
  await user.type(titleInput, 'Renamed draft')
  expect(screen.getByText('Unsaved changes')).toBeVisible()

  await user.click(screen.getByRole('button', { name: /Document Two/ }))
  expect(screen.getByRole('alertdialog')).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Keep editing' }))
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  expect(screen.getByRole('textbox', { name: 'Artifact title' })).toHaveValue(
    'Renamed draft'
  )

  await user.click(screen.getByRole('button', { name: /Document Two/ }))
  await user.click(
    await screen.findByRole('button', { name: 'Discard changes' })
  )
  await waitFor(() =>
    expect(screen.getByRole('textbox', { name: 'Artifact title' })).toHaveValue(
      'Document Two'
    )
  )
  expect(screen.queryByText('Unsaved changes')).toBeNull()
})

test('closing the panel with unsaved changes asks before discarding', async () => {
  const user = userEvent.setup()
  renderPanel()

  await user.click(await screen.findByRole('button', { name: /Document One/ }))
  const titleInput = await screen.findByRole('textbox', {
    name: 'Artifact title',
  })
  await user.type(titleInput, ' edited')

  await user.click(screen.getByRole('button', { name: 'Close' }))
  expect(screen.getByRole('alertdialog')).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Discard changes' }))
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
})

test('closing the panel without changes does not ask', async () => {
  const user = userEvent.setup()
  renderPanel()

  await user.click(await screen.findByRole('button', { name: /Document One/ }))
  await screen.findByRole('textbox', { name: 'Artifact title' })
  await user.click(screen.getByRole('button', { name: 'Close' }))
  expect(screen.queryByRole('alertdialog')).toBeNull()
  expect(onClose).toHaveBeenCalledTimes(1)
})

test('markdown artifact preview does not execute raw HTML, handlers or javascript: links', async () => {
  const user = userEvent.setup()
  const container = renderPanel()
  const scope = window as unknown as { __artifactXss?: boolean }
  scope.__artifactXss = undefined

  await user.click(await screen.findByRole('button', { name: /Unsafe Document/ }))
  await screen.findByRole('textbox', { name: 'Artifact title' })
  await user.click(screen.getByRole('button', { name: 'Preview artifact' }))

  expect(await screen.findByText('Unsafe answer')).toBeVisible()

  // Injection would surface as live script, iframe, inline handler, or a
  // javascript: URL. The sanitizing chain must strip all of them.
  expect(container.querySelector('script')).toBeNull()
  expect(container.querySelector('iframe')).toBeNull()
  expect(container.querySelector('[onerror]')).toBeNull()
  expect(container.querySelector('[onclick]')).toBeNull()
  for (const anchor of container.querySelectorAll('a')) {
    expect(anchor.getAttribute('href') ?? '').not.toMatch(/^javascript:/i)
  }
  expect(scope.__artifactXss).toBeUndefined()
})

test('code artifact keeps script and handler markup as inert text', async () => {
  const user = userEvent.setup()
  const container = renderPanel()

  await user.click(await screen.findByRole('button', { name: /Executable Code/ }))
  await screen.findByRole('textbox', { name: 'Artifact title' })
  const editor = screen.getByRole('textbox', { name: 'Artifact content' })
  const code = editor.querySelector('.cm-content')?.textContent ?? ''

  // The markup must be present verbatim as editable text...
  expect(code).toContain('<script>window.__artifactXss = true</script>')
  expect(code).toContain('onerror')
  // ...and must not have been parsed into live nodes anywhere in the panel.
  expect(container.querySelector('script')).toBeNull()
  expect(container.querySelector('[onerror]')).toBeNull()
  expect(container.querySelector('iframe')).toBeNull()
})

test('copying an artifact puts its full content on the clipboard', async () => {
  const user = userEvent.setup()
  const writeText = vi.spyOn(navigator.clipboard, 'writeText')
  renderPanel()

  await user.click(await screen.findByRole('button', { name: /Document One/ }))
  await screen.findByRole('textbox', { name: 'Artifact title' })
  await user.click(
    screen.getByRole('button', { name: 'Copy artifact content' })
  )

  await waitFor(() => expect(writeText).toHaveBeenCalledWith('First content'))
})

test('sending an artifact to a canvas reports the selected artifact', async () => {
  const user = userEvent.setup()
  const onSendToCanvas = vi.fn()
  renderPanel(onSendToCanvas)

  await user.click(await screen.findByRole('button', { name: /Document One/ }))
  await screen.findByRole('textbox', { name: 'Artifact title' })
  await user.click(screen.getByRole('button', { name: 'Send to canvas' }))

  expect(onSendToCanvas).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'pga_first', session_id: SESSION })
  )
})

test('downloading an artifact writes a sanitized filename and plain-text body', async () => {
  const user = userEvent.setup()
  const downloads = captureDownloads()
  renderPanel()

  await user.click(
    await screen.findByRole('button', { name: /Report: <draft>\/final\?/ })
  )
  await screen.findByRole('textbox', { name: 'Artifact title' })
  await user.click(screen.getByRole('button', { name: 'Download artifact' }))

  // Path separators and Windows-reserved characters are replaced, the trailing
  // extension is added, and the body keeps its exact text and MIME type.
  expect(downloads).toHaveLength(1)
  const [download] = downloads
  expect(download.filename).toBe('Report- -draft--final-.md')
  expect(download.blob.type).toBe('text/plain;charset=utf-8')
  await expect(download.blob.text()).resolves.toBe('Report body')
})

test('downloading a plaintext code artifact maps its extension to txt', async () => {
  const user = userEvent.setup()
  const downloads = captureDownloads()
  renderPanel()

  await user.click(await screen.findByRole('button', { name: /Plain Snippet/ }))
  await screen.findByRole('textbox', { name: 'Artifact title' })
  await user.click(screen.getByRole('button', { name: 'Download artifact' }))

  expect(downloads).toHaveLength(1)
  const [download] = downloads
  expect(download.filename).toBe('Plain Snippet.txt')
  await expect(download.blob.text()).resolves.toBe('plain text body')
})
