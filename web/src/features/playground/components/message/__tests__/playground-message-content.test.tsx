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
  MessageKnowledgeSnapshot,
  MessageVersion,
  PlaygroundDeveloperResponseFormat,
} from '../../../types'
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

function renderContent(
  message: Message,
  messageVersion: MessageVersion,
  knowledge?: MessageKnowledgeSnapshot | null,
  responseFormat: PlaygroundDeveloperResponseFormat | null = null
) {
  return render(
    <I18nextProvider i18n={testI18n}>
      <PlaygroundMessageContent
        actions={null}
        alignment='left'
        knowledge={knowledge}
        message={message}
        responseFormat={responseFormat}
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

describe('knowledge citations', () => {
  const knowledge: MessageKnowledgeSnapshot = {
    query: 'release notes',
    results: [
      {
        knowledgeBaseId: 'kb-1',
        knowledgeBaseName: 'Handbook',
        documentId: 'doc-1',
        filename: 'handbook.txt',
        chunkId: 'chunk-1',
        chunkIndex: 0,
        score: 0.9,
        text: 'The release notes live here.',
      },
      {
        knowledgeBaseId: 'kb-2',
        knowledgeBaseName: 'Notes',
        documentId: 'doc-2',
        filename: 'notes.txt',
        chunkId: 'chunk-2',
        chunkIndex: 1,
        score: 0.5,
        text: 'A second source.',
      },
    ],
  }

  test('renders the citation list and links inline [n] markers to it', async () => {
    const answered: Message = {
      key: 'assistant-knowledge',
      from: 'assistant',
      versions: [version],
      createdAt: 0,
      status: 'complete',
    }
    const { container } = renderContent(answered, version, knowledge)

    expect(screen.getByRole('button', { name: 'Used 2 sources' })).toBeVisible()
    expect(
      await screen.findByText('1. handbook.txt · Handbook')
    ).toBeInTheDocument()
    expect(screen.getByText('2. notes.txt · Notes')).toBeInTheDocument()

    const citation = container.querySelector(
      'a[href="#knowledge-source-assistant-knowledge-1"]'
    )
    expect(citation).not.toBeNull()
    expect(citation).toHaveTextContent('[1]')
  })

  test('renders no citation list without a knowledge snapshot', () => {
    const plainMessage: Message = {
      key: 'assistant-no-knowledge',
      from: 'assistant',
      versions: [version],
      createdAt: 0,
      status: 'complete',
    }
    renderContent(plainMessage, version)

    expect(screen.queryByRole('button', { name: 'Used 2 sources' })).toBeNull()
    expect(
      screen.queryByText('1. handbook.txt · Handbook')
    ).not.toBeInTheDocument()
  })
})

describe('structured response preview', () => {
  function assistantMessage(
    content: string,
    status: Message['status'] = 'complete'
  ): { message: Message; version: MessageVersion } {
    const answer: MessageVersion = { id: 'v-json', content }
    return {
      message: {
        key: 'assistant-json',
        from: 'assistant',
        versions: [answer],
        createdAt: 0,
        status,
      },
      version: answer,
    }
  }

  const schemaFormat: PlaygroundDeveloperResponseFormat = {
    type: 'json_schema',
    jsonSchema: {
      name: 'order_summary',
      schema: {
        type: 'object',
        properties: { total: { type: 'number' } },
        required: ['total', 'currency'],
        additionalProperties: false,
      },
    },
  }

  test('a reply matching the schema reports the match', () => {
    const { message, version: answer } = assistantMessage('{"total": 3}')
    renderContent(message, answer, null, {
      type: 'json_schema',
      jsonSchema: {
        name: 'order_summary',
        schema: {
          type: 'object',
          properties: { total: { type: 'number' } },
          required: ['total'],
        },
      },
    })

    expect(
      screen.getByText('Response matches the schema "order_summary".')
    ).toBeVisible()
  })

  test('a reply violating the schema lists every mismatch with its path', () => {
    const { message, version: answer } = assistantMessage(
      '{"total": "three", "extra": true}'
    )
    renderContent(message, answer, null, schemaFormat)

    expect(
      screen.getByText('Response does not match the schema (3 issues).')
    ).toBeVisible()
    expect(screen.getByText('$.total')).toBeVisible()
    expect(screen.getByText('Expected number')).toBeVisible()
    expect(
      screen.getByText('Missing required property "currency"')
    ).toBeVisible()
    expect(screen.getByText('Unexpected property "extra"')).toBeVisible()
  })

  test('a reply that is not JSON reports the skipped schema check', () => {
    const { message, version: answer } = assistantMessage('A plain answer.')
    renderContent(message, answer, null, { type: 'json_object' })

    expect(
      screen.getByText(
        'The response is not valid JSON, so the schema check was skipped.'
      )
    ).toBeVisible()
  })

  test('no preview appears without an active response format', () => {
    const { message, version: answer } = assistantMessage('{"total": 3}')
    renderContent(message, answer)

    expect(
      screen.queryByRole('button', { name: 'View formatted JSON' })
    ).toBeNull()
  })

  test('a reply that is still streaming shows no preview yet', () => {
    const { message, version: answer } = assistantMessage(
      '{"total": 3}',
      'streaming'
    )
    renderContent(message, answer, null, schemaFormat)

    expect(
      screen.queryByRole('button', { name: 'View formatted JSON' })
    ).toBeNull()
  })
})
