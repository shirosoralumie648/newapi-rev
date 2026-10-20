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
import { expect, test } from 'vitest'

import type { Message } from '../../../types'
import { MessageError } from '../message-error'

function errorMessage(overrides: Partial<Message>): Message {
  return {
    key: 'error-1',
    from: 'assistant',
    status: 'error',
    versions: [{ id: 'v1', content: '' }],
    ...overrides,
  }
}

test('an unknown error code keeps the original provider text', () => {
  render(
    <MessageError
      message={errorMessage({
        errorCode: 'custom_provider_error',
        versions: [{ id: 'v1', content: 'The provider refused this request.' }],
      })}
    />
  )

  expect(screen.getByText('Error')).toBeInTheDocument()
  expect(
    screen.getByText('The provider refused this request.')
  ).toBeInTheDocument()
})

test('an empty unknown error still shows the translated fallback', () => {
  render(<MessageError message={errorMessage({ errorCode: 'custom_error' })} />)

  expect(screen.getByText('An unknown error occurred')).toBeInTheDocument()
})

test('a known error code renders catalog copy instead of upstream text', () => {
  render(
    <MessageError
      message={errorMessage({
        errorCode: 'context_length_exceeded',
        versions: [
          {
            id: 'v1',
            content:
              'Rejected by https://channel.example.com with key sk-secret-value',
          },
        ],
      })}
    />
  )

  expect(
    screen.getByText('The conversation is too long for this model')
  ).toBeInTheDocument()
  expect(
    screen.getByText(
      'Compress older messages or lower the history limit, then try again.'
    )
  ).toBeInTheDocument()
  expect(screen.queryByText(/channel\.example\.com/)).not.toBeInTheDocument()
  expect(screen.queryByText(/sk-secret-value/)).not.toBeInTheDocument()
})

test('a model price error keeps its detail and adds the catalog description', () => {
  render(
    <MessageError
      message={errorMessage({
        errorCode: 'model_price_error',
        versions: [{ id: 'v1', content: 'No price for gpt-4o' }],
      })}
    />
  )

  expect(screen.getByText('Model Price Not Configured')).toBeInTheDocument()
  expect(screen.getByText('No price for gpt-4o')).toBeInTheDocument()
  expect(
    screen.getByText(
      'The selected model has no billing price. Ask an administrator to configure it.'
    )
  ).toBeInTheDocument()
})
