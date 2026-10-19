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
import type { GetTaskLogsParams, TaskLog } from '@/features/usage-logs/types'

import {
  PLAYGROUND_TASK_PAGE_SIZE,
  PLAYGROUND_TASK_POLL_INTERVAL_MS,
  PLAYGROUND_TASK_TERMINAL_STATUSES,
} from '../constants'
import {
  cancelPlaygroundTask,
  setPlaygroundTaskArtifactPin,
  submitAudioSpeech,
  submitAudioTranscription,
  submitImageGeneration,
  submitVideoGeneration,
  type PlaygroundAudioSpeechInput,
  type PlaygroundAudioTranscriptionInput,
  type PlaygroundImageGenerationInput,
  type PlaygroundVideoGenerationInput,
} from '../generation-api'
import { playgroundQueryKeys } from '../lib/query-keys'

/** Server-side filters over the generation metadata a task recorded. */
export interface PlaygroundTaskGenerationFilters {
  prompt?: string
  model?: string
  size?: string
  quality?: string
  seed?: number
  count?: number
}

function normalizeTaskGenerationFilters(
  filters: PlaygroundTaskGenerationFilters
): PlaygroundTaskGenerationFilters {
  const normalized: PlaygroundTaskGenerationFilters = {}
  if (filters.prompt?.trim()) normalized.prompt = filters.prompt.trim()
  if (filters.model?.trim()) normalized.model = filters.model.trim()
  if (filters.size?.trim()) normalized.size = filters.size.trim()
  if (filters.quality?.trim()) normalized.quality = filters.quality.trim()
  if (filters.seed !== undefined) normalized.seed = filters.seed
  if (filters.count !== undefined) normalized.count = filters.count
  return normalized
}

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
 *
 * The result gallery passes generation filters here, so prompt/model/size/
 * quality/seed/count narrow the durable rows on the server rather than only
 * the current page in the browser.
 */
export function usePlaygroundTasks(
  enabled: boolean,
  filters: PlaygroundTaskGenerationFilters = {}
) {
  const generationFilters = normalizeTaskGenerationFilters(filters)
  const hasFilters = Object.keys(generationFilters).length > 0
  const params: GetTaskLogsParams = {
    p: 1,
    page_size: PLAYGROUND_TASK_PAGE_SIZE,
    ...(generationFilters.prompt
      ? { generation_prompt: generationFilters.prompt }
      : {}),
    ...(generationFilters.model
      ? { generation_model: generationFilters.model }
      : {}),
    ...(generationFilters.size
      ? { generation_size: generationFilters.size }
      : {}),
    ...(generationFilters.quality
      ? { generation_quality: generationFilters.quality }
      : {}),
    ...(generationFilters.seed !== undefined
      ? { generation_seed: generationFilters.seed }
      : {}),
    ...(generationFilters.count !== undefined
      ? { generation_count: generationFilters.count }
      : {}),
  }
  return useQuery({
    queryKey: playgroundQueryKeys.tasks(
      hasFilters ? JSON.stringify(generationFilters) : 'list'
    ),
    enabled,
    queryFn: async () => {
      const response = await getUserTaskLogs(params)
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

/**
 * Keeps or releases one stored generation result. The server enforces
 * ownership and the finished task state; the artifact projection of the task
 * is invalidated so an open dialog shows the new retention state.
 */
export function useSetPlaygroundTaskArtifactPin() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: {
      taskId: string
      artifactKey: string
      pinned: boolean
    }) =>
      setPlaygroundTaskArtifactPin(
        input.taskId,
        input.artifactKey,
        input.pinned
      ),
    meta: { errorToast: false },
    onSuccess: (_pinned, variables) => {
      void queryClient.invalidateQueries({
        queryKey: ['usage-logs', 'task-artifacts', variables.taskId],
      })
    },
  })
}

/**
 * Cancels one running workspace task. Whether the request succeeds or reports
 * that the task already finished, the durable task rows and the account usage
 * view are refreshed, so the list always shows the settled state.
 */
export function useCancelPlaygroundTask() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (taskId: string) => cancelPlaygroundTask(taskId),
    meta: { errorToast: false },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: playgroundQueryKeys.tasksAll(),
      })
      void queryClient.invalidateQueries({
        predicate: (query) =>
          query.queryKey[0] === 'playground' && query.queryKey[2] === 'usage',
      })
    },
  })
}

/** The three generation mutations behind the workspace entry. */
export function usePlaygroundGeneration() {
  const queryClient = useQueryClient()
  const invalidateTasks = () =>
    queryClient.invalidateQueries({ queryKey: playgroundQueryKeys.tasksAll() })

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

/**
 * Dictation: one recorded clip transcribed through the /pg transcription
 * bridge. The relay bills the request like any other call; the returned text
 * is inserted into the composer.
 */
export function usePlaygroundTranscription() {
  return useMutation({
    mutationFn: (input: PlaygroundAudioTranscriptionInput) =>
      submitAudioTranscription(input),
    meta: { errorToast: false },
  })
}
