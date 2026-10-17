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
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createInstance, type i18n } from 'i18next'
import type { ComponentProps } from 'react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import en from '@/i18n/locales/en.json'
import { api } from '@/lib/api'

import { DEFAULT_CONFIG, DEFAULT_PARAMETER_ENABLED } from '../../../constants'
import { PlaygroundPresetPanel } from '../playground-preset-panel'

Object.defineProperty(HTMLElement.prototype, 'getAnimations', {
  configurable: true,
  value: () => [],
})

const presetWire = {
  id: 'pgp_1',
  name: 'Code reviewer',
  avatar: '🧑‍💻',
  config: { model: 'gpt-4o', temperature: 0.2 },
  parameter_enabled: { temperature: true },
  system_prompt: 'Review code carefully.',
  created_at: 10,
  updated_at: 20,
}

let testI18n: i18n

function renderPanel(
  overrides: Partial<ComponentProps<typeof PlaygroundPresetPanel>> = {}
) {
  const callbacks = {
    onApplyPreset: vi.fn(),
    onCreateSession: vi.fn(),
  }
  const view = render(
    <I18nextProvider i18n={testI18n}>
      <PlaygroundPresetPanel
        active
        currentConfig={DEFAULT_CONFIG}
        currentParameterEnabled={DEFAULT_PARAMETER_ENABLED}
        currentSystemPrompt=''
        models={[{ label: 'gpt-4o', value: 'gpt-4o' }]}
        {...callbacks}
        {...overrides}
      />
    </I18nextProvider>
  )
  return { ...callbacks, ...view }
}

beforeEach(async () => {
  testI18n = createInstance()
  await testI18n.init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  })
})

afterEach(() => vi.restoreAllMocks())

test('lists the owner presets and starts a conversation or applies one', async () => {
  const user = userEvent.setup()
  vi.spyOn(api, 'get').mockResolvedValue({
    data: {
      success: true,
      data: { items: [presetWire], total: 1, limit: 50 },
    },
  })
  const callbacks = renderPanel()

  expect(await screen.findByText('Code reviewer')).toBeVisible()
  expect(screen.getByText('Review code carefully.')).toBeVisible()
  expect(screen.getByText('1 of 50')).toBeVisible()

  await user.click(screen.getByRole('button', { name: 'New conversation' }))
  expect(callbacks.onCreateSession).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'pgp_1', name: 'Code reviewer' })
  )
  await user.click(
    screen.getByRole('button', { name: 'Apply to this conversation' })
  )
  expect(callbacks.onApplyPreset).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'pgp_1' })
  )
})

test('creating a preset posts the current settings without routing', async () => {
  const user = userEvent.setup()
  vi.spyOn(api, 'get').mockResolvedValue({
    data: { success: true, data: { items: [], total: 0, limit: 50 } },
  })
  const post = vi.spyOn(api, 'post').mockResolvedValue({
    data: {
      success: true,
      data: { ...presetWire, id: 'pgp_new', name: 'Reviewer' },
    },
  })
  renderPanel()

  await screen.findByText('No assistant presets yet')
  await user.click(screen.getByRole('button', { name: 'New preset' }))
  await user.type(await screen.findByLabelText('Preset name'), 'Reviewer')
  await user.click(screen.getByRole('button', { name: 'Save' }))

  await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
  const payload = post.mock.calls[0][1] as {
    name: string
    config: Record<string, unknown>
    parameter_enabled: Record<string, boolean>
    system_prompt: string
  }
  expect(payload.name).toBe('Reviewer')
  expect(payload.config.model).toBe(DEFAULT_CONFIG.model)
  expect(payload.config).not.toHaveProperty('group')
  expect(payload.parameter_enabled).toEqual(DEFAULT_PARAMETER_ENABLED)
  expect(payload.system_prompt).toBe('')
  expect(await screen.findByText('Reviewer')).toBeVisible()
})

test('deleting a preset confirms first and then removes it', async () => {
  const user = userEvent.setup()
  vi.spyOn(api, 'get').mockResolvedValue({
    data: {
      success: true,
      data: { items: [presetWire], total: 1, limit: 50 },
    },
  })
  const remove = vi
    .spyOn(api, 'delete')
    .mockResolvedValue({ data: { success: true, data: null } })
  renderPanel()

  await screen.findByText('Code reviewer')
  await user.click(screen.getByRole('button', { name: 'Delete preset' }))
  await user.click(await screen.findByRole('button', { name: 'Delete' }))

  await waitFor(() =>
    expect(remove).toHaveBeenCalledWith(
      '/api/playground/presets/pgp_1',
      expect.anything()
    )
  )
  expect(screen.queryByText('Code reviewer')).toBeNull()
})

test('a failed load keeps the panel on an error state with retry', async () => {
  vi.spyOn(api, 'get').mockRejectedValue(new Error('Offline'))
  renderPanel()

  expect(
    await screen.findByText('Failed to load assistant presets')
  ).toBeVisible()
  expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled()
})
