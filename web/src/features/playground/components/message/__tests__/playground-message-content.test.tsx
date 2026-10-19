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
import { beforeEach, describe, expect, test } from 'vitest'

import en from '@/i18n/locales/en.json'

import type { Message, MessageVersion } from '../../../types'
import { PlaygroundMessageContent } from '../playground-message-content'

Object.defineProperty(HTMLElement.prototype, 'getAnimations', {
  configurable: true,
  value: () => [],
})

let testI18n: i18n

beforeEach(async () => {
  testI18n = createInstance()
  await testI18n.init({
    lng: 'en',
    fallbackLng: 'en',
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  })
})

const version: MessageVersion = {
  id: 'v1',
  content: 'See the release notes [1].',
}

function renderContent(message: Message, messageVersion: MessageVersion) {
  return render(
    <I18nextProvider i18n={testI18n}>
      <PlaygroundMessageContent
        actions={null}
        alignment='left'
        message={message}
        version={messageVersion}
      />
    </I18nextProvider>
  )
}

describe('web-search citations', () => {
  test('shows the stored search hits as expandable sources', async () => {
    const user = userEvent.setup()
    const searchedMessage: Message = {
      key: 'assistant-search',
      from: 'assistant',
      versions: [version],
      createdAt: 0,
      status: 'complete',
      sources: [
        { href: 'https://go.dev/blog', title: 'Go releases' },
        { href: 'https://example.com/notes', title: 'Release notes' },
      ],
    }
    renderContent(searchedMessage, version)

    const trigger = screen.getByRole('button', { name: 'Used 2 sources' })
    expect(trigger).toBeVisible()
    expect(screen.queryByRole('link', { name: 'Go releases' })).toBeNull()

    await user.click(trigger)

    expect(
      await screen.findByRole('link', { name: 'Go releases' })
    ).toHaveAttribute('href', 'https://go.dev/blog')
    expect(screen.getByRole('link', { name: 'Release notes' })).toHaveAttribute(
      'href',
      'https://example.com/notes'
    )
  })

  test('renders an answer without a source list when the turn did not search', () => {
    const plainMessage: Message = {
      key: 'assistant-plain',
      from: 'assistant',
      versions: [version],
      createdAt: 0,
      status: 'complete',
    }
    renderContent(plainMessage, version)

    expect(screen.queryByRole('button', { name: /Used .* sources/ })).toBeNull()
  })
})
