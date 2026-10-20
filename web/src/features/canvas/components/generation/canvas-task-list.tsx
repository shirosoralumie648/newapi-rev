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
import { Send, SlidersHorizontal, Sparkles, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { EmptyState } from '@/components/empty-state'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import {
  buildTaskResultCanvasSeeds,
  type CanvasSendSeed,
} from '@/features/canvas/lib/canvas-send'
import {
  PLAYGROUND_GENERATION_ERRORS,
  PLAYGROUND_TASK_TERMINAL_STATUSES,
} from '@/features/playground/constants'
import {
  useCancelPlaygroundTask,
  usePlaygroundTasks,
  useSetPlaygroundTaskArtifactPin,
  useTaskArtifactsRequest,
  type PlaygroundTaskGenerationFilters,
} from '@/features/playground/hooks'
import { TaskArtifactsCell } from '@/features/usage-logs/components/task-artifacts'
import { taskStatusMapper } from '@/features/usage-logs/lib/mappers'
import type { TaskArtifact, TaskLog } from '@/features/usage-logs/types'
import { useDebounce } from '@/hooks/use-debounce'
import { formatLogQuota, formatUseTime } from '@/lib/format'
import { handleServerError } from '@/lib/handle-server-error'
import {
  getServerErrorMessage,
  translateServerText,
} from '@/lib/server-error-message'

interface CanvasTaskListProps {
  active: boolean
  /** Omitted by the workbench queue, which never sends results to the board. */
  onSendToCanvas?: (seeds: CanvasSendSeed[]) => void
  /** Case-insensitive client-side filter used by the asset library. */
  search?: string
  /** Show the server-side generation metadata filters of the result gallery. */
  showFilters?: boolean
  /** Keep only tasks that have not reached a terminal state. */
  onlyActive?: boolean
}

/**
 * The canvas view of the account's async generation tasks. Status, errors,
 * permissions and billing all come from the durable task rows through the
 * owner-scoped task endpoints, and artifacts are viewed through the shared
 * task artifact cell, so the canvas adds no second result store.
 */
export function CanvasTaskList(props: CanvasTaskListProps) {
  const { t } = useTranslation()
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [promptFilter, setPromptFilter] = useState('')
  const [modelFilter, setModelFilter] = useState('')
  const [sizeFilter, setSizeFilter] = useState('')
  const [qualityFilter, setQualityFilter] = useState('')
  const [seedFilter, setSeedFilter] = useState('')
  const [countFilter, setCountFilter] = useState('')
  const debouncedPrompt = useDebounce(promptFilter, 300)
  const debouncedModel = useDebounce(modelFilter, 300)
  const debouncedSize = useDebounce(sizeFilter, 300)
  const debouncedQuality = useDebounce(qualityFilter, 300)
  const parsedSeed = seedFilter.trim() ? Number(seedFilter) : undefined
  const parsedCount = countFilter.trim() ? Number(countFilter) : undefined
  const validSeed =
    parsedSeed !== undefined && Number.isSafeInteger(parsedSeed)
      ? parsedSeed
      : undefined
  const validCount =
    parsedCount !== undefined && Number.isSafeInteger(parsedCount)
      ? parsedCount
      : undefined
  const generationFilters: PlaygroundTaskGenerationFilters = props.showFilters
    ? {
        prompt: debouncedPrompt,
        model: debouncedModel,
        size: debouncedSize,
        quality: debouncedQuality,
        ...(validSeed !== undefined ? { seed: validSeed } : {}),
        ...(validCount !== undefined ? { count: validCount } : {}),
      }
    : {}
  const activeFilterCount = [
    promptFilter.trim(),
    modelFilter.trim(),
    sizeFilter.trim(),
    qualityFilter.trim(),
    seedFilter.trim(),
    countFilter.trim(),
  ].filter(Boolean).length
  const tasksQuery = usePlaygroundTasks(props.active, generationFilters)
  const artifactsRequest = useTaskArtifactsRequest()
  const setArtifactPin = useSetPlaygroundTaskArtifactPin()
  const cancelTask = useCancelPlaygroundTask()
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null)
  const [taskToCancel, setTaskToCancel] = useState<TaskLog | null>(null)
  const [artifactsByTask, setArtifactsByTask] = useState<
    Record<string, TaskArtifact[]>
  >({})

  const clearFilters = () => {
    setPromptFilter('')
    setModelFilter('')
    setSizeFilter('')
    setQualityFilter('')
    setSeedFilter('')
    setCountFilter('')
  }

  const loadArtifacts = async (task: TaskLog): Promise<TaskArtifact[]> => {
    const cached = artifactsByTask[task.task_id]
    if (cached) return cached
    const projection = await artifactsRequest.mutateAsync(task.task_id)
    setArtifactsByTask((current) => ({
      ...current,
      [task.task_id]: projection.artifacts,
    }))
    return projection.artifacts
  }

  const handleSendToCanvas = async (task: TaskLog) => {
    setPendingTaskId(task.task_id)
    try {
      const artifacts = await loadArtifacts(task)
      props.onSendToCanvas?.(
        buildTaskResultCanvasSeeds({
          taskId: task.task_id,
          label:
            task.properties?.origin_model_name || task.platform || task.action,
          artifacts: artifacts.map((artifact) => ({
            key: artifact.key,
            type: artifact.type,
          })),
        })
      )
    } catch (error) {
      handleServerError(
        error,
        t(PLAYGROUND_GENERATION_ERRORS.CANVAS_SEND_FAILED)
      )
    } finally {
      setPendingTaskId(null)
    }
  }

  const handleCancel = async () => {
    if (!taskToCancel) return
    try {
      await cancelTask.mutateAsync(taskToCancel.task_id)
      toast.success(t('Task canceled'))
    } catch (error) {
      handleServerError(
        error,
        t(PLAYGROUND_GENERATION_ERRORS.TASK_CANCEL_FAILED)
      )
    } finally {
      setTaskToCancel(null)
    }
  }

  // Keeping a stored result exempts it from the retention window; the server
  // re-checks ownership and the finished state on every request.
  const handleToggleArtifactPin = async (
    task: TaskLog,
    artifact: TaskArtifact
  ) => {
    const pinned = !artifact.pinned
    try {
      await setArtifactPin.mutateAsync({
        taskId: task.task_id,
        artifactKey: artifact.key,
        pinned,
      })
      toast.success(
        t(pinned ? 'Results will be kept' : 'Results will expire again')
      )
    } catch (error) {
      handleServerError(error, t(PLAYGROUND_GENERATION_ERRORS.PIN_FAILED))
    }
  }

  const filterControls = props.showFilters ? (
    <div className='grid gap-2'>
      <div className='flex items-center justify-between gap-2'>
        <Button
          aria-expanded={filtersOpen}
          aria-label={t('Filters')}
          onClick={() => setFiltersOpen((open) => !open)}
          size='sm'
          type='button'
          variant='outline'
        >
          <SlidersHorizontal aria-hidden='true' data-icon='inline-start' />
          {t('Filters')}
          {activeFilterCount > 0 ? (
            <span
              aria-hidden='true'
              className='bg-primary text-primary-foreground rounded-full px-1.5 text-[10px] leading-4'
            >
              {activeFilterCount}
            </span>
          ) : null}
        </Button>
        {activeFilterCount > 0 ? (
          <Button
            onClick={clearFilters}
            size='xs'
            type='button'
            variant='ghost'
          >
            {t('Clear filters')}
          </Button>
        ) : null}
      </div>
      {filtersOpen ? (
        <div className='grid grid-cols-2 gap-2'>
          <div className='col-span-2 grid gap-1'>
            <Label htmlFor='task-filter-prompt'>{t('Filter by prompt')}</Label>
            <Input
              id='task-filter-prompt'
              onChange={(event) => setPromptFilter(event.target.value)}
              placeholder={t('Search prompts')}
              value={promptFilter}
            />
          </div>
          <div className='grid gap-1'>
            <Label htmlFor='task-filter-model'>{t('Filter by model')}</Label>
            <Input
              id='task-filter-model'
              onChange={(event) => setModelFilter(event.target.value)}
              value={modelFilter}
            />
          </div>
          <div className='grid gap-1'>
            <Label htmlFor='task-filter-size'>{t('Filter by size')}</Label>
            <Input
              id='task-filter-size'
              onChange={(event) => setSizeFilter(event.target.value)}
              placeholder='1024x1024'
              value={sizeFilter}
            />
          </div>
          <div className='grid gap-1'>
            <Label htmlFor='task-filter-quality'>
              {t('Filter by quality')}
            </Label>
            <Input
              id='task-filter-quality'
              onChange={(event) => setQualityFilter(event.target.value)}
              value={qualityFilter}
            />
          </div>
          <div className='grid gap-1'>
            <Label htmlFor='task-filter-seed'>{t('Filter by seed')}</Label>
            <Input
              id='task-filter-seed'
              min={1}
              onChange={(event) => setSeedFilter(event.target.value)}
              type='number'
              value={seedFilter}
            />
          </div>
          <div className='grid gap-1'>
            <Label htmlFor='task-filter-count'>{t('Filter by count')}</Label>
            <Input
              id='task-filter-count'
              min={1}
              onChange={(event) => setCountFilter(event.target.value)}
              type='number'
              value={countFilter}
            />
          </div>
        </div>
      ) : null}
    </div>
  ) : null

  let content: ReactNode
  if (tasksQuery.isError) {
    content = (
      <p className='text-destructive text-sm' role='alert'>
        {getServerErrorMessage(
          tasksQuery.error,
          t(PLAYGROUND_GENERATION_ERRORS.TASK_LIST_FAILED)
        )}
      </p>
    )
  } else if (tasksQuery.isLoading) {
    content = (
      <p className='text-muted-foreground text-sm' role='status'>
        {t('Loading generation tasks...')}
      </p>
    )
  } else {
    const term = props.search?.trim().toLowerCase() ?? ''
    const serverFilterActive =
      [debouncedPrompt, debouncedModel, debouncedSize, debouncedQuality].some(
        (value) => value.trim() !== ''
      ) ||
      validSeed !== undefined ||
      validCount !== undefined
    const tasks = (tasksQuery.data ?? [])
      .filter((task) => {
        if (!term) return true
        return [
          task.task_id,
          task.action,
          task.platform,
          task.properties?.origin_model_name,
          task.generation?.prompt,
          task.generation?.model,
          task.generation?.size,
          task.generation?.quality,
          task.generation?.seed,
          task.generation?.count,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(term)
      })
      .filter(
        (task) =>
          !props.onlyActive ||
          !PLAYGROUND_TASK_TERMINAL_STATUSES.includes(task.status)
      )

    if (tasks.length === 0) {
      const filtered = serverFilterActive || term !== ''
      let title = t('No generation tasks')
      if (filtered) {
        title = t('No results found')
      } else if (props.onlyActive) {
        title = t('No generations are running.')
      }
      content = (
        <EmptyState
          className={filtered ? 'min-h-32' : 'min-h-40'}
          description={
            filtered
              ? undefined
              : props.onlyActive
                ? t('Running and waiting generations appear here.')
                : t('Start a generation and its status appears here.')
          }
          icon={Sparkles}
          title={title}
        />
      )
    } else {
      content = (
        <ul aria-label={t('Generation tasks')} className='grid gap-2'>
          {tasks.map((task) => {
            const isSuccessful = task.status === 'SUCCESS'
            const isPending = pendingTaskId === task.task_id
            const failure = task.fail_reason?.trim()
            const isTerminal = PLAYGROUND_TASK_TERMINAL_STATUSES.includes(
              task.status
            )
            const generation = task.generation
            const modelLabel =
              generation?.model ||
              task.properties?.origin_model_name ||
              task.platform
            const taskStart = task.start_time ?? task.submit_time
            const elapsedSeconds =
              task.finish_time && taskStart && task.finish_time >= taskStart
                ? task.finish_time - taskStart
                : undefined
            const generationParams = [
              generation?.size,
              generation?.quality,
              generation?.seed !== undefined
                ? t('Seed {{seed}}', { seed: generation.seed })
                : '',
              generation?.count
                ? t('Count {{count}}', { count: generation.count })
                : '',
              generation?.duration
                ? t('Duration {{seconds}}s', {
                    seconds: generation.duration,
                  })
                : '',
            ].filter(Boolean)
            return (
              <li
                className='rounded-lg border p-2.5'
                key={task.task_id || String(task.id)}
              >
                <div className='flex items-center justify-between gap-2'>
                  <StatusBadge
                    copyable={false}
                    label={t(
                      taskStatusMapper.getLabel(
                        task.status,
                        task.status || 'Submitting'
                      )
                    )}
                    variant={taskStatusMapper.getVariant(task.status)}
                  />
                  <span
                    className='text-muted-foreground truncate text-xs'
                    title={modelLabel}
                  >
                    {modelLabel}
                  </span>
                </div>
                {generation?.prompt ? (
                  <p
                    className='mt-1 line-clamp-2 text-xs break-words'
                    title={generation.prompt}
                  >
                    {generation.prompt}
                  </p>
                ) : null}
                <p className='text-muted-foreground mt-1 truncate text-xs'>
                  {[task.action, task.progress].filter(Boolean).join(' · ')}
                </p>
                {generationParams.length > 0 ? (
                  <p className='text-muted-foreground mt-1 flex flex-wrap gap-x-2 text-xs'>
                    {generationParams.map((param, index) => (
                      <span key={`${param}-${index}`}>{param}</span>
                    ))}
                  </p>
                ) : null}
                {elapsedSeconds !== undefined || task.quota > 0 ? (
                  <p className='text-muted-foreground mt-1 flex flex-wrap gap-x-3 text-xs'>
                    {elapsedSeconds !== undefined ? (
                      <span>
                        {t('Elapsed {{time}}', {
                          time: formatUseTime(elapsedSeconds),
                        })}
                      </span>
                    ) : null}
                    {task.quota > 0 ? (
                      <span>
                        {t('Cost {{quota}}', {
                          quota: formatLogQuota(task.quota),
                        })}
                      </span>
                    ) : null}
                  </p>
                ) : null}
                {failure ? (
                  <p className='text-destructive mt-1 text-xs break-words'>
                    {translateServerText(t, failure)}
                  </p>
                ) : null}
                {isSuccessful && props.onSendToCanvas ? (
                  <div className='mt-2 flex flex-wrap items-center gap-1.5'>
                    <TaskArtifactsCell
                      log={task}
                      onTogglePin={(artifact) =>
                        void handleToggleArtifactPin(task, artifact)
                      }
                    />
                    <Button
                      aria-label={t('Send to canvas')}
                      disabled={isPending}
                      onClick={() => void handleSendToCanvas(task)}
                      size='xs'
                      type='button'
                      variant='outline'
                    >
                      {isPending ? (
                        <Spinner data-icon='inline-start' />
                      ) : (
                        <Send aria-hidden='true' data-icon='inline-start' />
                      )}
                      {t('Send to canvas')}
                    </Button>
                  </div>
                ) : null}
                {isTerminal ? null : (
                  <div className='mt-2 flex flex-wrap items-center gap-1.5'>
                    <Button
                      aria-label={t('Cancel task')}
                      onClick={() => setTaskToCancel(task)}
                      size='xs'
                      type='button'
                      variant='outline'
                    >
                      <X aria-hidden='true' data-icon='inline-start' />
                      {t('Cancel task')}
                    </Button>
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )
    }
  }

  return (
    <div className='grid gap-2'>
      {filterControls}
      {content}
      <ConfirmDialog
        confirmText={t('Cancel task')}
        desc={t('The task will be canceled and its reserved quota refunded.')}
        destructive
        handleConfirm={() => void handleCancel()}
        isLoading={cancelTask.isPending}
        onOpenChange={(open) => {
          if (!open) setTaskToCancel(null)
        }}
        open={taskToCancel !== null}
        title={t('Cancel this task?')}
      />
    </div>
  )
}
