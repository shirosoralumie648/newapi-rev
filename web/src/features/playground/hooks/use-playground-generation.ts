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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { getTaskArtifacts, getUserTaskLogs } from '@/features/usage-logs/api'
import type { TaskLog } from '@/features/usage-logs/types'

import {
  PLAYGROUND_TASK_PAGE_SIZE,
  PLAYGROUND_TASK_POLL_INTERVAL_MS,
  PLAYGROUND_TASK_TERMINAL_STATUSES,
} from '../constants'
import {
  submitAudioSpeech,
  submitImageGeneration,
  submitVideoGeneration,
  type PlaygroundAudioSpeechInput,
  type PlaygroundImageGenerationInput,
  type PlaygroundVideoGenerationInput,
} from '../generation-api'
import { playgroundQueryKeys } from '../lib/query-keys'

function hasUnfinishedTask(tasks: TaskLog[] | undefined): boolean {
  if (!tasks) return false
  return tasks.some(
    (task) => !PLAYGROUND_TASK_TERMINAL_STATUSES.includes(task.status)
  )
}

/**
 * The account's recent async generation tasks. The durable task rows are the
 * status source, so this reuses the owner-scoped dashboard endpoint instead of
 * inventing a second status contract; it keeps polling only while one of the
 * loaded tasks is unfinished.
 */
export function usePlaygroundTasks(enabled: boolean) {
  return useQuery({
    queryKey: playgroundQueryKeys.tasks(),
    enabled,
    queryFn: async () => {
      const response = await getUserTaskLogs({
        p: 1,
        page_size: PLAYGROUND_TASK_PAGE_SIZE,
      })
      return (response.data?.items ?? []) as TaskLog[]
    },
    meta: { errorToast: false },
    refetchInterval: (query) =>
      hasUnfinishedTask(query.state.data)
        ? PLAYGROUND_TASK_POLL_INTERVAL_MS
        : false,
  })
}

/**
 * Loads one task's artifacts on demand, so browsing the task list never runs
 * an upstream artifact projection.
 */
export function useTaskArtifactsRequest() {
  return useMutation({
    mutationFn: (taskId: string) => getTaskArtifacts(taskId),
    meta: { errorToast: false },
  })
}

/** The three generation mutations behind the workspace entry. */
export function usePlaygroundGeneration() {
  const queryClient = useQueryClient()
  const invalidateTasks = () =>
    queryClient.invalidateQueries({ queryKey: playgroundQueryKeys.tasks() })

  const image = useMutation({
    mutationFn: (input: PlaygroundImageGenerationInput) =>
      submitImageGeneration(input),
    meta: { errorToast: false },
    onSuccess: () => void invalidateTasks(),
  })
  const video = useMutation({
    mutationFn: (input: PlaygroundVideoGenerationInput) =>
      submitVideoGeneration(input),
    meta: { errorToast: false },
    onSuccess: () => void invalidateTasks(),
  })
  const audio = useMutation({
    mutationFn: (input: PlaygroundAudioSpeechInput) => submitAudioSpeech(input),
    meta: { errorToast: false },
  })

  return { image, video, audio }
}
