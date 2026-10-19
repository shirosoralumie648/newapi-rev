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
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Dialog } from '@/components/dialog'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

import { usePlaygroundMessageCosts } from '../../hooks'
import type { PlaygroundComparisonRunner } from '../../hooks/use-playground-comparison-runner'
import { comparisonRequestIds } from '../../lib'
import type { ModelOption, PlaygroundMessageCost } from '../../types'
import { PlaygroundComparisonForm } from './playground-comparison-form'
import { PlaygroundComparisonHistory } from './playground-comparison-history'
import { PlaygroundComparisonResults } from './playground-comparison-results'

type ComparisonTab = 'run' | 'results' | 'history'

interface PlaygroundComparisonDialogProps {
  disabled?: boolean
  /** Group the compare cells are sent with. */
  group: string
  /** Composer's parallel selection, seeded into a fresh form. */
  initialModels: string[]
  models: ModelOption[]
  onOpenChange: (open: boolean) => void
  open: boolean
  runner: PlaygroundComparisonRunner
  userId: number | null
}

/**
 * Batch compare workbench: many prompts against a bounded model selection.
 * The client orchestrates the cells as ordinary `/pg` requests and persists the
 * matrix through the compare-run API, so closing the dialog does not stop an
 * already running batch and the history can reopen it later.
 */
export function PlaygroundComparisonDialog(
  props: PlaygroundComparisonDialogProps
) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<ComparisonTab>('run')
  const runRef = useRef(props.runner.run)
  const wasRunningRef = useRef(false)

  useEffect(() => {
    runRef.current = props.runner.run
  }, [props.runner.run])

  useEffect(() => {
    if (!props.open) return
    setTab(runRef.current ? 'results' : 'run')
  }, [props.open])

  // A run that starts while the form is visible opens its live table instead of
  // leaving the user on a disabled form.
  useEffect(() => {
    if (props.runner.isRunning && !wasRunningRef.current) {
      setTab('results')
    }
    wasRunningRef.current = props.runner.isRunning
  }, [props.runner.isRunning])

  const requestIds = useMemo(
    () => (props.runner.run ? comparisonRequestIds(props.runner.run) : []),
    [props.runner.run]
  )
  const costsQuery = usePlaygroundMessageCosts(props.userId, requestIds)
  const costs = useMemo(
    () => costsQuery.data?.costs ?? new Map<string, PlaygroundMessageCost>(),
    [costsQuery.data]
  )

  return (
    <Dialog
      bodyClassName='grid gap-3'
      contentClassName='max-sm:w-[calc(100vw-1rem)] sm:max-w-4xl'
      contentHeight='min(72vh, 42rem)'
      description={t(
        'Send the same prompts to several models and compare the settled results.'
      )}
      footer={
        <Button
          onClick={() => props.onOpenChange(false)}
          type='button'
          variant='outline'
        >
          {t('Close')}
        </Button>
      }
      onOpenChange={props.onOpenChange}
      open={props.open}
      title={t('Compare runs')}
    >
      {props.runner.message ? (
        <p
          className='bg-destructive/10 text-destructive rounded-md px-3 py-2 text-sm'
          role='alert'
        >
          {t(props.runner.message)}
        </p>
      ) : null}

      <Tabs
        onValueChange={(value) => {
          if (value === 'run' || value === 'results' || value === 'history') {
            setTab(value)
          }
        }}
        value={tab}
      >
        <TabsList>
          <TabsTrigger value='run'>{t('New run')}</TabsTrigger>
          <TabsTrigger value='results'>{t('Results')}</TabsTrigger>
          <TabsTrigger value='history'>{t('History')}</TabsTrigger>
        </TabsList>

        <TabsContent className='grid gap-3' value='run'>
          <PlaygroundComparisonForm
            disabled={props.disabled}
            group={props.group}
            initialModels={props.initialModels}
            models={props.models}
            onStart={props.runner.start}
            onStop={props.runner.stop}
            open={props.open}
            running={props.runner.isRunning}
          />
        </TabsContent>

        <TabsContent className='grid gap-3' value='results'>
          <PlaygroundComparisonResults
            costs={costs}
            onRetry={props.runner.retryCell}
            onSetBaseline={props.runner.setBaseline}
            onStartNew={() => setTab('run')}
            onStop={props.runner.stop}
            retryingKey={props.runner.retryingKey}
            run={props.runner.run}
            running={props.runner.isRunning}
          />
        </TabsContent>

        <TabsContent className='grid gap-3' value='history'>
          <PlaygroundComparisonHistory
            active={props.open && tab === 'history'}
            disabled={props.runner.isRunning}
            onLoad={(run) => {
              props.runner.load(run)
              setTab('results')
            }}
            onRemove={props.runner.remove}
          />
        </TabsContent>
      </Tabs>
    </Dialog>
  )
}
