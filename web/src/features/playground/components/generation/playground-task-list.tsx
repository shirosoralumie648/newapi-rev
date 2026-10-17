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
import { Send, Sparkles, X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { EmptyState } from '@/components/empty-state'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import {
  buildTaskResultCanvasSeeds,
  type CanvasSendSeed,
} from '@/features/canvas/lib/canvas-send'
import { TaskArtifactsCell } from '@/features/usage-logs/components/task-artifacts'
import { taskStatusMapper } from '@/features/usage-logs/lib/mappers'
import type { TaskArtifact, TaskLog } from '@/features/usage-logs/types'
import { handleServerError } from '@/lib/handle-server-error'
import {
  getServerErrorMessage,
  translateServerText,
} from '@/lib/server-error-message'

import {
  PLAYGROUND_GENERATION_ERRORS,
  PLAYGROUND_TASK_TERMINAL_STATUSES,
} from '../../constants'
import {
  useCancelPlaygroundTask,
  usePlaygroundTasks,
  useTaskArtifactsRequest,
} from '../../hooks'

interface PlaygroundTaskListProps {
  active: boolean
  onSendToCanvas: (seeds: CanvasSendSeed[]) => void
}

/**
 * The workspace view of the account's async generation tasks. Status, errors,
 * permissions and billing all come from the durable task rows through the
 * owner-scoped task endpoints, and artifacts are viewed through the shared
 * task artifact cell, so the Playground adds no second result store.
 */
export function PlaygroundTaskList(props: PlaygroundTaskListProps) {
  const { t } = useTranslation()
  const tasksQuery = usePlaygroundTasks(props.active)
  const artifactsRequest = useTaskArtifactsRequest()
  const cancelTask = useCancelPlaygroundTask()
  const [pendingTaskId, setPendingTaskId] = useState<string | null>(null)
  const [taskToCancel, setTaskToCancel] = useState<TaskLog | null>(null)
  const [artifactsByTask, setArtifactsByTask] = useState<
    Record<string, TaskArtifact[]>
  >({})

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
      props.onSendToCanvas(
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

  if (tasksQuery.isError) {
    return (
      <p className='text-destructive text-sm' role='alert'>
        {getServerErrorMessage(
          tasksQuery.error,
          t(PLAYGROUND_GENERATION_ERRORS.TASK_LIST_FAILED)
        )}
      </p>
    )
  }
  if (tasksQuery.isLoading) {
    return (
      <p className='text-muted-foreground text-sm' role='status'>
        {t('Loading generation tasks...')}
      </p>
    )
  }
  if (tasksQuery.data && tasksQuery.data.length === 0) {
    return (
      <EmptyState
        className='min-h-40'
        description={t('Start a generation and its status appears here.')}
        icon={Sparkles}
        title={t('No generation tasks')}
      />
    )
  }

  return (
    <>
      <ul aria-label={t('Generation tasks')} className='grid gap-2'>
        {(tasksQuery.data ?? []).map((task) => {
          const isSuccessful = task.status === 'SUCCESS'
          const isPending = pendingTaskId === task.task_id
          const failure = task.fail_reason?.trim()
          const isTerminal = PLAYGROUND_TASK_TERMINAL_STATUSES.includes(
            task.status
          )
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
                <span className='text-muted-foreground truncate text-xs'>
                  {task.properties?.origin_model_name || task.platform}
                </span>
              </div>
              <p className='text-muted-foreground mt-1 truncate text-xs'>
                {[task.action, task.progress].filter(Boolean).join(' · ')}
              </p>
              {failure ? (
                <p className='text-destructive mt-1 text-xs break-words'>
                  {translateServerText(t, failure)}
                </p>
              ) : null}
              {isSuccessful ? (
                <div className='mt-2 flex flex-wrap items-center gap-1.5'>
                  <TaskArtifactsCell log={task} />
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
    </>
  )
}
