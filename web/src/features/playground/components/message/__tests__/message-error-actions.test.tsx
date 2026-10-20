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
import { expect, test, vi } from 'vitest'

import { getPlaygroundErrorCatalogEntry } from '../../../lib'
import { MessageErrorActions } from '../message-error-actions'

test('a context error opens context management and offers one retry', async () => {
  const user = userEvent.setup()
  const onOpenContext = vi.fn()
  const onRetry = vi.fn()
  const catalog = getPlaygroundErrorCatalogEntry('context_length_exceeded')

  render(
    <MessageErrorActions
      catalog={catalog}
      onOpenContext={onOpenContext}
      onRetry={onRetry}
    />
  )

  await user.click(screen.getByRole('button', { name: 'Manage context' }))
  await user.click(screen.getByRole('button', { name: 'Retry' }))

  expect(onOpenContext).toHaveBeenCalledTimes(1)
  expect(onRetry).toHaveBeenCalledTimes(1)
  expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(1)
})

test('an insufficient balance error opens the wallet or switches group', async () => {
  const user = userEvent.setup()
  const onOpenWallet = vi.fn()
  const onSwitchGroup = vi.fn()
  const onRetry = vi.fn()
  const catalog = getPlaygroundErrorCatalogEntry('insufficient_user_quota')

  render(
    <MessageErrorActions
      catalog={catalog}
      onOpenWallet={onOpenWallet}
      onRetry={onRetry}
      onSwitchGroup={onSwitchGroup}
    />
  )

  await user.click(screen.getByRole('button', { name: 'Open wallet' }))
  await user.click(screen.getByRole('button', { name: 'Switch group' }))

  expect(onOpenWallet).toHaveBeenCalledTimes(1)
  expect(onSwitchGroup).toHaveBeenCalledTimes(1)
  // The catalog decides which repair actions apply; a generic retry would
  // spend the same failing request again.
  expect(onRetry).not.toHaveBeenCalled()
  expect(
    screen.queryByRole('button', { name: 'Retry' })
  ).not.toBeInTheDocument()
})

test('a vision error removes the images or changes the model', async () => {
  const user = userEvent.setup()
  const onRemoveImages = vi.fn()
  const onChangeModel = vi.fn()
  const catalog = getPlaygroundErrorCatalogEntry('vision_not_supported')

  render(
    <MessageErrorActions
      catalog={catalog}
      onChangeModel={onChangeModel}
      onRemoveImages={onRemoveImages}
    />
  )

  await user.click(screen.getByRole('button', { name: 'Remove images' }))
  await user.click(screen.getByRole('button', { name: 'Change model' }))

  expect(onRemoveImages).toHaveBeenCalledTimes(1)
  expect(onChangeModel).toHaveBeenCalledTimes(1)
})

test('a protocol error can switch to Chat Completions', async () => {
  const user = userEvent.setup()
  const onUseChatProtocol = vi.fn()
  const catalog = getPlaygroundErrorCatalogEntry('invalid_api_type')

  render(
    <MessageErrorActions
      catalog={catalog}
      onUseChatProtocol={onUseChatProtocol}
    />
  )

  await user.click(screen.getByRole('button', { name: 'Use Chat Completions' }))

  expect(onUseChatProtocol).toHaveBeenCalledTimes(1)
})

test('an unknown error keeps the generic retry action', async () => {
  const user = userEvent.setup()
  const onRetry = vi.fn()

  render(<MessageErrorActions catalog={null} onRetry={onRetry} />)

  await user.click(screen.getByRole('button', { name: 'Retry' }))

  expect(onRetry).toHaveBeenCalledTimes(1)
})

test('a catalog action without a callback is not rendered', () => {
  const catalog = getPlaygroundErrorCatalogEntry('context_length_exceeded')

  render(<MessageErrorActions catalog={catalog} />)

  expect(
    screen.queryByRole('button', { name: 'Manage context' })
  ).not.toBeInTheDocument()
  expect(
    screen.queryByRole('button', { name: 'Retry' })
  ).not.toBeInTheDocument()
})
