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
import { describe, expect, test, vi } from 'vitest'

import type { GenerationBatchPlan } from '@/features/playground/lib/generation/generation-batch'

import {
  generationErrorCode,
  generationPlanEstimateSteps,
  generationShouldStopAfterError,
  runGenerationBatch,
  type CanvasGenerationSubmit,
} from '../canvas-generation-run'

function planWithRequests(count: number): GenerationBatchPlan {
  return {
    mode: 'variations',
    kind: 'image',
    prompt: 'a red fox',
    group: 'default',
    requests: Array.from({ length: count }, (_, index) => ({
      id: `variations-${index}`,
      kind: 'image',
      model: 'img-a',
      prompt: 'a red fox',
      group: 'default',
      seed: 100 + index,
      count: 1,
      size: '1024x1024',
      adjustments: [],
    })),
    blocked: [],
  }
}

describe('media batch runner', () => {
  test('prices one synthetic estimate step per planned request', () => {
    const steps = generationPlanEstimateSteps(planWithRequests(2))

    expect(steps.map((step) => step.nodeId)).toEqual([
      'variations-0',
      'variations-1',
    ])
    expect(steps[0]).toMatchObject({
      kind: 'image',
      model: 'img-a',
      group: 'default',
      count: 1,
      size: '1024x1024',
    })
    expect(steps[0]?.tokens).toBeGreaterThan(0)
  })

  test('recognizes the stable quota error codes that stop a batch', () => {
    const error = {
      response: { data: { error: { code: 'insufficient_user_quota' } } },
    }
    expect(generationErrorCode(error)).toBe('insufficient_user_quota')
    expect(generationShouldStopAfterError('insufficient_user_quota')).toBe(true)
    expect(generationShouldStopAfterError('invalid_request')).toBe(false)
  })

  test('stops after a fatal error and skips the queued cells', async () => {
    const updates = new Map<string, string | undefined>()
    const submit: CanvasGenerationSubmit = async (request) => {
      if (request.id === 'variations-1') {
        throw {
          response: {
            data: { error: { code: 'insufficient_user_quota' } },
          },
        }
      }
      return { images: [{ url: `https://cdn.example.com/${request.id}.png` }] }
    }

    await runGenerationBatch({
      plan: planWithRequests(3),
      concurrency: 2,
      submit,
      signal: new AbortController().signal,
      onCell: (requestId, update) =>
        updates.set(requestId, update.status ?? updates.get(requestId)),
    })

    expect(updates.get('variations-0')).toBe('succeeded')
    expect(updates.get('variations-1')).toBe('failed')
    expect(updates.get('variations-2')).toBe('skipped')
  })

  test('does not submit anything once the signal is aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const submit = vi.fn<CanvasGenerationSubmit>()
    const statuses: string[] = []

    await runGenerationBatch({
      plan: planWithRequests(2),
      concurrency: 2,
      submit,
      signal: controller.signal,
      onCell: (_requestId, update) => {
        if (update.status) statuses.push(update.status)
      },
    })

    expect(submit).not.toHaveBeenCalled()
    expect(statuses).toEqual(['skipped', 'skipped'])
  })
})
