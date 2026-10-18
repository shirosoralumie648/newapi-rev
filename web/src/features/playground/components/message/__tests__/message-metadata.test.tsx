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

import type {
  Message,
  MessageVersion,
  PlaygroundMessageCost,
} from '../../../types'
import { MessageMetadata } from '../message-metadata'

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
  content: 'Answer',
  requestId: 'req-1',
  usage: { promptTokens: 1200, completionTokens: 345, totalTokens: 1545 },
}

const message: Message = {
  key: 'assistant-1',
  from: 'assistant',
  versions: [version],
  createdAt: 0,
  startedAt: 0,
  completedAt: 1500,
  durationMs: 1500,
  status: 'complete',
}

function renderMetadata(props: {
  version?: MessageVersion
  cost?: PlaygroundMessageCost
}) {
  return render(
    <I18nextProvider i18n={testI18n}>
      <MessageMetadata
        alignment='left'
        cost={props.cost}
        message={message}
        version={props.version ?? version}
      />
    </I18nextProvider>
  )
}

describe('message usage metadata', () => {
  test('shows the reported tokens and the settled cost of the version', () => {
    renderMetadata({
      cost: {
        requestId: 'req-1',
        quota: 1234,
        promptTokens: 1200,
        completionTokens: 345,
        totalTokens: 1545,
        modelName: 'test-model',
        createdAt: 0,
      },
    })

    expect(screen.getByText('Tokens: 1,545')).toBeVisible()
    expect(screen.getByText('Cost: $0.002468')).toBeVisible()
    expect(screen.getByText('Response time: 1.50s')).toBeVisible()
  })

  test('reveals the prompt and completion breakdown of the token count', async () => {
    const user = userEvent.setup()
    renderMetadata({})

    await user.hover(screen.getByText('Tokens: 1,545'))

    expect(await screen.findByText('Input Tokens: 1,200')).toBeVisible()
    expect(screen.getByText('Output Tokens: 345')).toBeVisible()
    expect(screen.getByText('Total Tokens: 1,545')).toBeVisible()
  })

  test('falls back to the settle row when the version has no recorded usage', () => {
    renderMetadata({
      version: { id: 'v2', content: 'Imported answer', requestId: 'req-2' },
      cost: {
        requestId: 'req-2',
        quota: 0,
        promptTokens: 1,
        completionTokens: 2,
        totalTokens: 3,
        modelName: 'test-model',
        createdAt: 0,
      },
    })

    expect(screen.getByText('Tokens: 3')).toBeVisible()
    expect(screen.getByText('Cost: $0')).toBeVisible()
  })

  test('renders nothing when the message has no generation record or timing', () => {
    const { container } = render(
      <I18nextProvider i18n={testI18n}>
        <MessageMetadata
          alignment='left'
          message={{
            key: 'user-1',
            from: 'user',
            versions: [{ id: 'u1', content: 'Question' }],
          }}
          version={{ id: 'u1', content: 'Question' }}
        />
      </I18nextProvider>
    )

    expect(container).toBeEmptyDOMElement()
  })
})

describe('message timing metadata', () => {
  function costWithTiming(
    timing: NonNullable<PlaygroundMessageCost['timing']>
  ): PlaygroundMessageCost {
    return {
      requestId: 'req-1',
      quota: 0,
      promptTokens: 1,
      completionTokens: 2,
      totalTokens: 3,
      modelName: 'test-model',
      createdAt: 0,
      timing,
    }
  }

  test('reveals the server-measured phase breakdown of the request', async () => {
    const user = userEvent.setup()
    renderMetadata({
      cost: costWithTiming({
        total_ms: 1320,
        auth_ms: 24,
        channel_select_ms: 8,
        upstream_ms: 411,
        first_token_ms: 445,
        retries: 1,
      }),
    })

    await user.hover(screen.getByText('First token: 445ms'))

    expect(await screen.findByText('Upstream first byte')).toBeVisible()
    expect(screen.getByText('411ms')).toBeVisible()
    expect(screen.getByText('Channel selection')).toBeVisible()
    expect(screen.getByText('Retries')).toBeVisible()
  })

  test('falls back to the total when the entry never reported a first token', () => {
    renderMetadata({ cost: costWithTiming({ total_ms: 1320 }) })

    expect(screen.getByText('Total: 1.32s')).toBeVisible()
  })

  test('adds no timing entry for a cost row without a breakdown', () => {
    renderMetadata({
      cost: {
        requestId: 'req-1',
        quota: 0,
        promptTokens: 1,
        completionTokens: 2,
        totalTokens: 3,
        modelName: 'test-model',
        createdAt: 0,
      },
    })

    expect(screen.queryByText(/First token:/)).toBeNull()
    expect(screen.queryByText(/Total:/)).toBeNull()
  })
})
