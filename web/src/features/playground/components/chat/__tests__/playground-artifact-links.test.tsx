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
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createInstance, type i18n } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { beforeEach, expect, test, vi } from 'vitest'

import en from '@/i18n/locales/en.json'

import type { PlaygroundArtifactSummary } from '../../../artifact-api'
import { PlaygroundArtifactLinks } from '../playground-artifact-links'

let testI18n: i18n

const artifacts: PlaygroundArtifactSummary[] = [
  {
    id: 'pga_1',
    session_id: 'pgs_1',
    kind: 'markdown',
    revision: 1,
    current_version_id: 'pgv_1',
    title: 'Notes',
    language: 'markdown',
    created_at: 1,
    updated_at: 1,
  },
  {
    id: 'pga_2',
    session_id: 'pgs_1',
    kind: 'code',
    revision: 1,
    current_version_id: 'pgv_2',
    title: 'Snippet',
    language: 'typescript',
    created_at: 2,
    updated_at: 2,
  },
]

beforeEach(async () => {
  testI18n = createInstance()
  await testI18n.init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  })
})

test('shows at most three saved artifacts and opens one in the canvas', async () => {
  const user = userEvent.setup()
  const onOpenArtifact = vi.fn()
  render(
    <I18nextProvider i18n={testI18n}>
      <PlaygroundArtifactLinks
        artifacts={artifacts}
        onOpenArtifact={onOpenArtifact}
      />
    </I18nextProvider>
  )

  expect(screen.getByText('Saved artifacts')).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Open canvas: Notes' }))
  expect(onOpenArtifact).toHaveBeenCalledWith(artifacts[0])
})

test('renders nothing when the conversation has no saved artifacts', () => {
  render(
    <I18nextProvider i18n={testI18n}>
      <PlaygroundArtifactLinks artifacts={[]} onOpenArtifact={vi.fn()} />
    </I18nextProvider>
  )

  expect(screen.queryByText('Saved artifacts')).toBeNull()
})
