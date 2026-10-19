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
import { createInstance, type i18n } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { beforeEach, describe, expect, test } from 'vitest'

import en from '@/i18n/locales/en.json'

import type { Message, PlaygroundMessageCost } from '../../../types'
import { PlaygroundSessionUsage } from '../playground-session-usage'

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

const messages: Message[] = [
  {
    key: 'user-1',
    from: 'user',
    versions: [{ id: 'u1', content: 'Question' }],
  },
  {
    key: 'assistant-1',
    from: 'assistant',
    activeVersionIndex: 1,
    versions: [
      {
        id: 'a1',
        content: 'First answer',
        requestId: 'req-old',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      },
      {
        id: 'a2',
        content: 'Regenerated answer',
        requestId: 'req-new',
        usage: { promptTokens: 1200, completionTokens: 345, totalTokens: 1545 },
      },
    ],
  },
]

const costs = new Map<string, PlaygroundMessageCost>([
  [
    'req-old',
    {
      requestId: 'req-old',
      quota: 9999,
      promptTokens: 1,
      completionTokens: 1,
      totalTokens: 2,
      modelName: 'test-model',
      createdAt: 0,
    },
  ],
  [
    'req-new',
    {
      requestId: 'req-new',
      quota: 1234,
      promptTokens: 1200,
      completionTokens: 345,
      totalTokens: 1545,
      modelName: 'test-model',
      createdAt: 0,
    },
  ],
])

function renderSummary(
  costsOverride?: ReadonlyMap<string, PlaygroundMessageCost>,
  costLoggingEnabled?: boolean
) {
  return render(
    <I18nextProvider i18n={testI18n}>
      <PlaygroundSessionUsage
        costLoggingEnabled={costLoggingEnabled}
        costs={costsOverride ?? costs}
        messages={messages}
      />
    </I18nextProvider>
  )
}

describe('conversation usage summary', () => {
  test('totals the displayed versions and their settled costs', () => {
    renderSummary()

    expect(screen.getByText('Session usage')).toBeVisible()
    expect(screen.getByText('Tokens: 1,545')).toBeVisible()
    // Only the selected branch is billed, so the older version's row is not added.
    expect(screen.getByText('Cost: $0.002468')).toBeVisible()
  })

  test('shows tokens without a cost while the settle rows are still loading', () => {
    renderSummary(new Map())

    expect(screen.getByText('Tokens: 1,545')).toBeVisible()
    expect(screen.queryByText(/^Cost: /)).not.toBeInTheDocument()
  })

  test('renders nothing for a conversation without any generation record', () => {
    const { container } = render(
      <I18nextProvider i18n={testI18n}>
        <PlaygroundSessionUsage messages={[messages[0]]} />
      </I18nextProvider>
    )

    expect(container).toBeEmptyDOMElement()
  })
})

describe('consumption-log availability', () => {
  test('explains a missing settled cost when consumption logs are off', () => {
    renderSummary(new Map(), false)

    expect(screen.getByText('Tokens: 1,545')).toBeVisible()
    expect(screen.queryByText(/^Cost: /)).not.toBeInTheDocument()
    expect(
      screen.getByText(
        'Settled cost details are unavailable because consumption logs are turned off.'
      )
    ).toBeVisible()
  })

  test('keeps quiet when every request already has a settled row', () => {
    renderSummary(costs, false)

    expect(screen.getByText('Cost: $0.002468')).toBeVisible()
    expect(screen.queryByText(/consumption logs/)).not.toBeInTheDocument()
  })

  test('does not claim the log is off before the lookup answers', () => {
    renderSummary(new Map(), undefined)

    expect(screen.queryByText(/consumption logs/)).not.toBeInTheDocument()
  })
})
