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
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createInstance, type i18n } from 'i18next'
import type { ComponentProps } from 'react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { TaskArtifact, TaskLog } from '@/features/usage-logs/types'
import en from '@/i18n/locales/en.json'
import { api } from '@/lib/api'

import { CanvasGenerationPanel } from '../canvas-generation-panel'

Object.defineProperty(HTMLElement.prototype, 'getAnimations', {
  configurable: true,
  value: () => [],
})

let testI18n: i18n

const taskFixture: TaskLog = {
  id: 11,
  user_id: 7,
  platform: 'kling',
  task_id: 't1',
  action: 'GENERATE',
  channel_id: 3,
  group: 'default',
  quota: 0,
  submit_time: 1700000000,
  status: 'SUCCESS',
  properties: { origin_model_name: 'kling-v1' },
}

const artifactFixture: TaskArtifact = {
  key: 'output-1',
  type: 'image',
  mime_type: 'image/png',
  content_url: `https://gateway.example.com/v1/tasks/t1/artifacts/output-1/content?access=${'a'.repeat(43)}`,
}

function mockTaskEndpoints(
  tasks: TaskLog[],
  artifacts: TaskArtifact[] = [],
  queueItems: Array<Record<string, unknown>> = []
) {
  return vi.spyOn(api, 'get').mockImplementation(async (url) => {
    if (url.startsWith('/api/task/self')) {
      return {
        data: { success: true, data: { items: tasks, total: tasks.length } },
      }
    }
    if (url.endsWith('/artifacts')) {
      return { data: { success: true, data: { artifacts } } }
    }
    if (url.endsWith('/tasks/queue')) {
      return {
        data: {
          success: true,
          data: {
            enabled: queueItems.length > 0,
            items: queueItems,
            max_queued: 20,
            max_concurrency: 3,
          },
        },
      }
    }
    throw new Error(`Unexpected GET ${url}`)
  })
}

function mockBatchEndpoints() {
  return vi.spyOn(api, 'post').mockImplementation(async (url, body) => {
    if (url === '/api/playground/workflows/estimate') {
      const steps = (body as { steps: Array<{ node_id: string }> }).steps
      return {
        data: {
          success: true,
          data: {
            steps: steps.map((step) => ({
              node_id: step.node_id,
              quota: 100,
              available: true,
              approximate: false,
            })),
            total_quota: steps.length * 100,
            available: true,
          },
        },
      }
    }
    if (url === '/pg/images/generations') {
      const model = String((body as { model?: string }).model ?? 'image')
      return {
        data: {
          created: 1,
          data: [{ url: `https://cdn.example.com/${model}.png` }],
        },
      }
    }
    if (url === '/pg/videos') {
      return { data: { id: 'video-batch-1', status: 'queued' } }
    }
    throw new Error(`Unexpected POST ${url}`)
  })
}

async function confirmBatchEstimate(user: ReturnType<typeof userEvent.setup>) {
  const dialog = await screen.findByRole('dialog')
  const confirm = await within(dialog).findByRole('button', {
    name: 'Generate batch',
  })
  await waitFor(() => expect(confirm).toBeEnabled())
  await user.click(confirm)
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  )
}

function renderPanel(
  onSendToCanvas = vi.fn(),
  overrides: Partial<ComponentProps<typeof CanvasGenerationPanel>> = {}
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <I18nextProvider i18n={testI18n}>
      <QueryClientProvider client={client}>
        <CanvasGenerationPanel
          active
          group='default'
          models={[{ label: 'gpt-image-1', value: 'gpt-image-1' }]}
          onSendToCanvas={onSendToCanvas}
          {...overrides}
        />
      </QueryClientProvider>
    </I18nextProvider>
  )
  return onSendToCanvas
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

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

test('generating an image posts to the playground relay route and previews the result', async () => {
  mockTaskEndpoints([])
  vi.spyOn(api, 'post').mockResolvedValue({
    data: {
      created: 1,
      data: [{ url: 'https://cdn.example.com/fox.png' }],
    },
  })
  const user = userEvent.setup()
  renderPanel()

  await user.type(screen.getByLabelText('Prompt'), 'a red fox')
  await user.click(screen.getByRole('button', { name: 'Generate' }))

  expect(api.post).toHaveBeenCalledWith(
    '/pg/images/generations',
    expect.objectContaining({
      model: 'gpt-image-1',
      prompt: 'a red fox',
      group: 'default',
    }),
    expect.anything()
  )
  expect(await screen.findByAltText('Generated image 1')).toBeVisible()
})

test('an asynchronous image submission leaves the result to the task list', async () => {
  mockTaskEndpoints([])
  vi.spyOn(api, 'post').mockResolvedValue({
    data: {
      success: true,
      data: { task_id: 'task-3', status: 'submitted', model: 'gpt-image-1' },
    },
  })
  const user = userEvent.setup()
  renderPanel()

  await user.type(screen.getByLabelText('Prompt'), 'a red fox')
  await user.click(screen.getByRole('button', { name: 'Generate' }))

  expect(
    await screen.findByText(
      'Image generation submitted as a task; the result appears in the task list.'
    )
  ).toBeVisible()
  expect(screen.queryByAltText('Generated image 1')).not.toBeInTheDocument()
})

test('generating a video posts to the playground video route', async () => {
  mockTaskEndpoints([])
  vi.spyOn(api, 'post').mockResolvedValue({
    data: { id: 'video-1', status: 'queued' },
  })
  const user = userEvent.setup()
  renderPanel()

  await user.click(screen.getByRole('button', { name: 'Video' }))
  await user.type(screen.getByLabelText('Prompt'), 'a sailing ship')
  await user.click(screen.getByRole('button', { name: 'Generate' }))

  expect(api.post).toHaveBeenCalledWith(
    '/pg/videos',
    expect.objectContaining({
      model: 'gpt-image-1',
      prompt: 'a sailing ship',
      group: 'default',
      duration: 5,
    }),
    expect.anything()
  )
})

test('a successful task result is sent to the canvas as a task reference', async () => {
  mockTaskEndpoints([taskFixture], [artifactFixture])
  const user = userEvent.setup()
  const onSendToCanvas = renderPanel()

  expect(await screen.findByText('Success')).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Send to canvas' }))

  expect(api.get).toHaveBeenCalledWith(
    '/api/task/t1/artifacts',
    expect.anything()
  )
  await waitFor(() =>
    expect(onSendToCanvas).toHaveBeenCalledWith([
      {
        kind: 'task-result',
        label: 'kling-v1 · image',
        ref: { taskId: 't1', taskArtifactKey: 'output-1' },
      },
    ])
  )
})

test('a stored result is kept for its owner through the pin endpoint', async () => {
  mockTaskEndpoints([taskFixture], [{ ...artifactFixture, stored: true }])
  const put = vi.spyOn(api, 'put').mockResolvedValue({
    data: { success: true, data: { pinned: true } },
  })
  const user = userEvent.setup()
  renderPanel()

  await screen.findByText('Success')
  await user.click(screen.getByRole('button', { name: /Artifacts/ }))
  await user.click(await screen.findByRole('button', { name: 'Keep results' }))

  expect(put).toHaveBeenCalledWith(
    '/api/playground/tasks/t1/artifacts/output-1/pin',
    { pinned: true },
    expect.anything()
  )
})

test('a running task is canceled through the confirm dialog', async () => {
  mockTaskEndpoints([
    { ...taskFixture, id: 12, task_id: 't2', status: 'IN_PROGRESS' },
  ])
  const post = vi.spyOn(api, 'post').mockResolvedValue({
    data: { success: true, data: { task_id: 't2', status: 'FAILURE' } },
  })
  const user = userEvent.setup()
  renderPanel()

  await user.click(await screen.findByRole('button', { name: 'Cancel task' }))
  const dialog = await screen.findByRole('alertdialog')
  expect(dialog).toHaveTextContent('Cancel this task?')
  await user.click(within(dialog).getByRole('button', { name: 'Cancel task' }))

  expect(post).toHaveBeenCalledWith(
    '/api/playground/tasks/t2/cancel',
    {},
    expect.anything()
  )
  await waitFor(() =>
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  )
})

test('a failed task list request shows the error instead of an empty state', async () => {
  vi.spyOn(api, 'get').mockRejectedValue(new Error('Offline'))
  renderPanel()

  expect(await screen.findByRole('alert')).toHaveTextContent('Offline')
  expect(screen.queryByText('No generation tasks')).not.toBeInTheDocument()
})

test('variations send distinct seeds and rerun reuses the same plan', async () => {
  mockTaskEndpoints([])
  const post = mockBatchEndpoints()
  const user = userEvent.setup()
  renderPanel()

  await user.click(screen.getByRole('button', { name: 'Variations' }))
  await user.type(screen.getByLabelText('Prompt'), 'a red fox')
  const seedInput = screen.getByLabelText('Base seed')
  await user.clear(seedInput)
  await user.type(seedInput, '100')
  const countInput = screen.getByLabelText('Number of variations')
  await user.selectOptions(countInput, '2')
  await user.click(
    screen.getByRole('button', { name: 'Review cost and generate' })
  )
  await confirmBatchEstimate(user)

  await waitFor(() => {
    const imageCalls = post.mock.calls.filter(
      ([url]) => url === '/pg/images/generations'
    )
    expect(imageCalls).toHaveLength(2)
  })
  const bodies = post.mock.calls
    .filter(([url]) => url === '/pg/images/generations')
    .map(([, body]) => body as { seed?: number })
  expect(bodies.map((body) => body.seed)).toEqual([100, 101])
  expect(await screen.findByText(/Seed 100/)).toBeVisible()
  expect(screen.getByText(/Seed 101/)).toBeVisible()

  await user.click(
    screen.getByRole('button', { name: 'Re-run with same params' })
  )
  await confirmBatchEstimate(user)

  await waitFor(() => {
    const imageCalls = post.mock.calls.filter(
      ([url]) => url === '/pg/images/generations'
    )
    expect(imageCalls).toHaveLength(4)
  })
  const rerunBodies = post.mock.calls
    .filter(([url]) => url === '/pg/images/generations')
    .slice(2)
    .map(([, body]) => body as { seed?: number })
  expect(rerunBodies.map((body) => body.seed)).toEqual([100, 101])
})

test('comparison shares one seed and maps each model to its own size', async () => {
  mockTaskEndpoints([])
  const post = mockBatchEndpoints()
  const user = userEvent.setup()
  renderPanel(vi.fn(), {
    models: [
      { label: 'img-a', value: 'img-a' },
      { label: 'img-b', value: 'img-b' },
    ],
    modelCapabilities: {
      'img-a': { usageSchema: { size: { enum: ['1024x1024'] } } },
      'img-b': { usageSchema: { size: { enum: ['1792x1024'] } } },
    },
  })

  await user.click(screen.getByRole('button', { name: 'Compare' }))
  await user.type(screen.getByLabelText('Prompt'), 'a lighthouse')
  await user.click(
    screen.getByRole('button', { name: 'Review cost and generate' })
  )
  await confirmBatchEstimate(user)

  await waitFor(() => {
    const imageCalls = post.mock.calls.filter(
      ([url]) => url === '/pg/images/generations'
    )
    expect(imageCalls).toHaveLength(2)
  })
  const bodies = post.mock.calls
    .filter(([url]) => url === '/pg/images/generations')
    .map(([, body]) => body as { model?: string; seed?: number; size?: string })
  expect(bodies.map((body) => body.model)).toEqual(['img-a', 'img-b'])
  expect(bodies[0]?.seed).toBe(bodies[1]?.seed)
  expect(bodies[0]?.size).toBe('1024x1024')
  expect(bodies[1]?.size).toBe('1792x1024')
  expect(
    await screen.findByText(
      'Size 1024x1024 is not available for img-b; using 1792x1024.'
    )
  ).toBeVisible()
})

test('shows the server queue position and lets the owner cancel or jump', async () => {
  mockTaskEndpoints(
    [],
    [],
    [
      {
        id: 'pgq_1',
        kind: 'video',
        status: 'queued',
        priority: 0,
        position: 2,
        estimated_wait_seconds: 120,
        model: 'kling-v1',
        prompt_preview: 'a queued fox',
        created_at: 1700000000,
      },
    ]
  )
  const remove = vi.spyOn(api, 'delete').mockResolvedValue({
    data: {
      success: true,
      data: {
        queue: {
          id: 'pgq_1',
          kind: 'video',
          status: 'canceled',
          priority: 0,
          position: 0,
          estimated_wait_seconds: 0,
          model: 'kling-v1',
          prompt_preview: 'a queued fox',
          created_at: 1700000000,
        },
      },
    },
  })
  const post = vi.spyOn(api, 'post').mockResolvedValue({
    data: {
      success: true,
      data: {
        queue: {
          id: 'pgq_1',
          kind: 'video',
          status: 'queued',
          priority: 1,
          position: 1,
          estimated_wait_seconds: 60,
          model: 'kling-v1',
          prompt_preview: 'a queued fox',
          created_at: 1700000000,
        },
      },
    },
  })
  const user = userEvent.setup()
  renderPanel()

  expect(await screen.findByText('a queued fox')).toBeVisible()
  expect(screen.getByText('Queue position: 2')).toBeVisible()
  expect(screen.getByText('Estimated wait: 2m 0s')).toBeVisible()

  await user.click(screen.getByRole('button', { name: 'Move to front' }))
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      '/api/playground/tasks/queue/pgq_1/priority',
      {},
      expect.anything()
    )
  )

  await user.click(
    screen.getByRole('button', { name: 'Cancel queued generation' })
  )
  await waitFor(() =>
    expect(remove).toHaveBeenCalledWith(
      '/api/playground/tasks/queue/pgq_1',
      expect.anything()
    )
  )
})

test('a model without image capability blocks the comparison before billing', async () => {
  mockTaskEndpoints([])
  const post = mockBatchEndpoints()
  const user = userEvent.setup()
  renderPanel(vi.fn(), {
    models: [
      { label: 'video-only', value: 'video-only' },
      { label: 'img-b', value: 'img-b' },
    ],
    modelCapabilities: {
      'video-only': {
        endpointTypes: ['openai-video'],
        usageFields: ['seconds'],
      },
      'img-b': {
        endpointTypes: ['image-generation'],
        usageFields: ['image_count'],
      },
    },
  })

  await user.click(screen.getByRole('button', { name: 'Compare' }))
  await user.type(screen.getByLabelText('Prompt'), 'a lighthouse')
  await user.click(
    screen.getByRole('button', { name: 'Review cost and generate' })
  )

  expect(
    await screen.findByText('This model cannot generate images.')
  ).toBeVisible()
  expect(
    screen.getByText('Remove the models that cannot generate this media first.')
  ).toBeVisible()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(post).not.toHaveBeenCalled()
})
