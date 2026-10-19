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
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Dialog } from '@/components/dialog'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { formatLogQuota, parseQuotaFromDollars } from '@/lib/format'
import { getServerErrorMessage } from '@/lib/server-error-message'

import {
  createCanvasWorkflowRunBudget,
  estimateCanvasWorkflowRun,
} from '../api'
import type { CanvasWorkflowRunEstimate } from '../api'
import {
  CANVAS_NODE_KIND_LABELS,
  CANVAS_WORKFLOW_BUDGET_MESSAGES,
  CANVAS_WORKFLOW_GENERATION_LABELS,
} from '../constants'
import type { CanvasWorkflowRunBudgetRef } from '../hooks/use-canvas-workflow-runner'
import type { CanvasWorkflowEstimateStepInput } from '../lib/canvas-workflow-budget'

interface CanvasRunBudgetDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Group the run's relay calls use; the server prices the steps with it. */
  group: string
  /** The steps of the run a click would start, in run order. */
  steps: CanvasWorkflowEstimateStepInput[]
  /** Starts the run; a run id bills its steps inside the opened budget. */
  onRun: (budget?: CanvasWorkflowRunBudgetRef) => void
}

/**
 * Confirmation of a canvas workflow run: every step is priced by the server
 * before anything is sent, the pre-charge is summed, and the user may cap what
 * the run reserves. The cap opens one wallet budget the steps bill inside;
 * without a cap the run bills the wallet directly, as before.
 */
export function CanvasRunBudgetDialog(props: CanvasRunBudgetDialogProps) {
  const { t } = useTranslation()
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [estimate, setEstimate] = useState<CanvasWorkflowRunEstimate | null>(
    null
  )
  const [errorText, setErrorText] = useState('')
  const [cap, setCap] = useState('')
  const [starting, setStarting] = useState(false)

  const refresh = useCallback(async () => {
    setStatus('loading')
    setErrorText('')
    try {
      const priced = await estimateCanvasWorkflowRun(props.group, props.steps)
      setEstimate(priced)
      setStatus('ready')
    } catch (error) {
      setErrorText(getServerErrorMessage(error))
      setStatus('error')
    }
  }, [props.group, props.steps])

  useEffect(() => {
    if (!props.open) return
    setCap('')
    void refresh()
  }, [props.open, refresh])

  const trimmedCap = cap.trim()
  const capQuota = trimmedCap ? parseQuotaFromDollars(Number(trimmedCap)) : 0
  const capInvalid = trimmedCap !== '' && capQuota <= 0

  const startRun = async () => {
    if (starting || capInvalid) return
    let budget: CanvasWorkflowRunBudgetRef | undefined
    if (capQuota > 0) {
      setStarting(true)
      try {
        const opened = await createCanvasWorkflowRunBudget(capQuota)
        budget = { runId: opened.runId }
      } catch (error) {
        setStarting(false)
        toast.error(
          t(
            getServerErrorMessage(
              error,
              CANVAS_WORKFLOW_BUDGET_MESSAGES.START_FAILED
            )
          )
        )
        return
      }
      setStarting(false)
    }
    // Start while the parent can still read the plan the dialog was opened
    // for, then close; the scope of a selection run must not depend on state
    // teardown order.
    props.onRun(budget)
    props.onOpenChange(false)
  }

  return (
    <Dialog
      bodyClassName='space-y-4'
      contentClassName='max-sm:w-[calc(100vw-1.5rem)] sm:max-w-md'
      contentHeight='auto'
      description={t('Review the estimated cost before the run starts.')}
      footer={
        <>
          <Button
            disabled={starting}
            onClick={() => props.onOpenChange(false)}
            type='button'
            variant='outline'
          >
            {t('Cancel')}
          </Button>
          <Button
            disabled={starting || status !== 'ready' || capInvalid}
            onClick={() => void startRun()}
            type='button'
          >
            {starting && <Spinner />}
            {t('Run workflow')}
          </Button>
        </>
      }
      onOpenChange={props.onOpenChange}
      open={props.open}
      title={t('Run workflow')}
    >
      {status === 'loading' && <LoadingState className='min-h-20' />}
      {status === 'error' && (
        <ErrorState
          className='min-h-0'
          description={errorText}
          onRetry={() => void refresh()}
          title={t(CANVAS_WORKFLOW_BUDGET_MESSAGES.ESTIMATE_FAILED)}
        />
      )}
      {status === 'ready' && estimate !== null && (
        <>
          <div className='grid gap-1.5'>
            {estimate.steps.map((step) => {
              const plan = props.steps.find(
                (input) => input.nodeId === step.nodeId
              )
              const label = plan
                ? [
                    plan.model,
                    t(
                      plan.kind === 'chat'
                        ? CANVAS_NODE_KIND_LABELS.model
                        : CANVAS_WORKFLOW_GENERATION_LABELS[plan.kind]
                    ),
                  ]
                    .filter(Boolean)
                    .join(' · ')
                : step.nodeId
              return (
                <div
                  className='flex items-center justify-between gap-3 text-sm'
                  key={step.nodeId}
                >
                  <span className='min-w-0 truncate'>{label}</span>
                  <span className='text-muted-foreground shrink-0 text-xs'>
                    {step.available
                      ? formatLogQuota(step.quota)
                      : t('Not priced')}
                  </span>
                </div>
              )
            })}
          </div>
          <div className='flex items-center justify-between border-t pt-2'>
            <span className='text-sm font-medium'>{t('Estimated total')}</span>
            <span className='text-sm font-medium'>
              {formatLogQuota(estimate.totalQuota)}
            </span>
          </div>
          {!estimate.available && (
            <p className='text-muted-foreground text-xs'>
              {t(CANVAS_WORKFLOW_BUDGET_MESSAGES.UNAVAILABLE)}
            </p>
          )}
          {estimate.steps.some((step) => step.approximate) && (
            <p className='text-muted-foreground text-xs'>
              {t(CANVAS_WORKFLOW_BUDGET_MESSAGES.APPROXIMATE)}
            </p>
          )}
          <div className='grid gap-1.5'>
            <Label htmlFor='canvas-run-budget-cap'>
              {t('Run budget cap (optional)')}
            </Label>
            <Input
              aria-invalid={capInvalid}
              id='canvas-run-budget-cap'
              inputMode='decimal'
              onChange={(event) => setCap(event.target.value)}
              value={cap}
            />
            <p className='text-muted-foreground text-xs'>
              {t(
                'Caps what this run may reserve from your wallet; the unspent part is returned after the run.'
              )}
            </p>
            {capInvalid && (
              <p className='text-destructive text-xs'>
                {t('Enter an amount greater than zero.')}
              </p>
            )}
            {!capInvalid && capQuota > 0 && estimate.totalQuota > capQuota && (
              <p className='text-xs text-amber-600'>
                {t(CANVAS_WORKFLOW_BUDGET_MESSAGES.BELOW_ESTIMATE)}
              </p>
            )}
          </div>
        </>
      )}
    </Dialog>
  )
}
