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
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { beforeEach, expect, test, vi } from 'vitest'

import { api } from '@/lib/api'

import { SettingsPageProvider } from '../../components/settings-page-context'
import { PlaygroundMCPSection } from '../playground-mcp-section'

type MCPBody = { mcp: string }

function mcpBody(): MCPBody | undefined {
  return vi
    .mocked(api.put)
    .mock.calls.map((call) => [call[0], call[1]] as [string, MCPBody])
    .find(([url]) => url === '/api/option/playground/mcp')?.[1]
}

function storedServer(overrides: Record<string, unknown> = {}) {
  return {
    id: 'github',
    name: 'GitHub',
    url: 'https://mcp.example.com/mcp',
    enabled: true,
    header: 'Authorization',
    has_token: true,
    ...overrides,
  }
}

function Fixture(props: { mcpJson: string }) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null)
  return (
    <>
      <div ref={setContainer} />
      <SettingsPageProvider actionsContainer={container}>
        <PlaygroundMCPSection mcpJson={props.mcpJson} />
      </SettingsPageProvider>
    </>
  )
}

function renderSection(mcp: Record<string, unknown> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <Fixture mcpJson={JSON.stringify(mcp)} />
    </QueryClientProvider>
  )
}

async function save(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Save MCP settings' }))
}

beforeEach(() => {
  vi.spyOn(api, 'put').mockResolvedValue({ data: { success: true } })
})

test('a new connection is saved with the whole list and no credential', async () => {
  const user = userEvent.setup()
  renderSection()

  await user.click(screen.getByRole('button', { name: 'Add connection' }))
  await user.type(screen.getByLabelText('ID'), 'github')
  await user.type(screen.getByLabelText('Name'), 'GitHub')
  await user.type(
    screen.getByLabelText('Server URL'),
    'https://mcp.example.com/mcp'
  )
  await save(user)

  await waitFor(() => expect(mcpBody()).toBeDefined())
  expect(JSON.parse(mcpBody()?.mcp ?? '{}')).toEqual({
    enabled: false,
    servers: [
      {
        id: 'github',
        name: 'GitHub',
        url: 'https://mcp.example.com/mcp',
        enabled: true,
        header: 'Authorization',
      },
    ],
  })
})

test('a typed token replaces the stored one and travels with its connection', async () => {
  const user = userEvent.setup()
  renderSection({ enabled: true, servers: [storedServer()] })

  await user.type(screen.getByLabelText('Access token'), 'ghp_secret')
  await save(user)

  await waitFor(() => expect(mcpBody()).toBeDefined())
  const saved = JSON.parse(mcpBody()?.mcp ?? '{}')
  expect(saved.servers[0]).toEqual({
    id: 'github',
    name: 'GitHub',
    url: 'https://mcp.example.com/mcp',
    enabled: true,
    header: 'Authorization',
    auth_token: 'ghp_secret',
  })
})

test('an unrelated edit keeps the stored credential out of the request', async () => {
  const user = userEvent.setup()
  renderSection({ enabled: true, servers: [storedServer()] })

  await user.click(screen.getByRole('switch', { name: 'Connection enabled' }))
  await save(user)

  await waitFor(() => expect(mcpBody()).toBeDefined())
  const saved = JSON.parse(mcpBody()?.mcp ?? '{}')
  expect(saved.servers[0].enabled).toBe(false)
  expect(saved.servers[0].auth_token).toBeUndefined()
  expect(saved.servers[0].clear_token).toBeUndefined()
})

test('removing a stored token is saved as an explicit clear', async () => {
  const user = userEvent.setup()
  renderSection({ enabled: true, servers: [storedServer()] })

  await user.click(
    screen.getByRole('button', { name: 'Remove the stored token' })
  )
  await save(user)

  await waitFor(() => expect(mcpBody()).toBeDefined())
  const saved = JSON.parse(mcpBody()?.mcp ?? '{}')
  expect(saved.servers[0].clear_token).toBe(true)
  expect(saved.servers[0].auth_token).toBeUndefined()
})

test('an invalid connection is reported in place and never saved', async () => {
  const user = userEvent.setup()
  renderSection()

  await user.click(screen.getByRole('button', { name: 'Add connection' }))
  await user.type(screen.getByLabelText('Server URL'), 'ftp://mcp.example.com')
  await save(user)

  expect(
    await screen.findByText(
      'Use 1-24 letters, digits, hyphens or underscores, starting with a letter or digit.'
    )
  ).toBeVisible()
  expect(screen.getByLabelText('ID')).toHaveAttribute('aria-invalid', 'true')
  expect(
    screen.getByText('Enter a name of at most 100 characters.')
  ).toBeVisible()
  expect(
    screen.getByText(
      'Enter an http(s) URL without credentials, query parameters or fragments.'
    )
  ).toBeVisible()
  expect(api.put).not.toHaveBeenCalled()
})

test('a stored credential without a header is reported before saving', async () => {
  const user = userEvent.setup()
  renderSection({ enabled: true, servers: [storedServer({ header: '' })] })

  await save(user)

  expect(
    await screen.findByText('Choose a header before storing a token.')
  ).toBeVisible()
  expect(screen.getByLabelText('Access token')).toHaveAttribute(
    'aria-invalid',
    'true'
  )
  expect(api.put).not.toHaveBeenCalled()
})

test('an unchanged configuration is not saved again', async () => {
  const user = userEvent.setup()
  renderSection({ enabled: true, servers: [storedServer()] })

  await save(user)

  await waitFor(() => expect(api.put).not.toHaveBeenCalled())
})
