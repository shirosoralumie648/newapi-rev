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
import {
  BarChartIcon,
  Bot,
  Brain,
  CodeSquareIcon,
  GraduationCapIcon,
  Images,
  MessageSquarePlusIcon,
  NotepadTextIcon,
  SlidersHorizontal,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'

import { PlaygroundNoModelsNotice } from '../onboarding/playground-no-models-notice'

type PlaygroundEmptyStateProps = {
  onSelectPrompt: (prompt: string) => void
  /** Display-only greeting of the preset that started the conversation. */
  openingMessage?: string
  /** Starter questions of that preset; they replace the generic examples. */
  suggestedQuestions?: string[]
  /** Show capability entries only while the first-visit onboarding is open. */
  showFeatureCards?: boolean
  /** The current group has no chat model to send a request to. */
  noAvailableModels?: boolean
  onOpenParameters?: () => void
  onOpenPresets?: () => void
  onOpenMemory?: () => void
  onOpenCanvas?: () => void
}

const starterPrompts = [
  { icon: BarChartIcon, text: 'Analyze data' },
  { icon: NotepadTextIcon, text: 'Summarize text' },
  { icon: CodeSquareIcon, text: 'Code' },
  { icon: GraduationCapIcon, text: 'Get advice' },
]

export function PlaygroundEmptyState({
  onSelectPrompt,
  openingMessage = '',
  suggestedQuestions = [],
  showFeatureCards = false,
  noAvailableModels = false,
  onOpenParameters,
  onOpenPresets,
  onOpenMemory,
  onOpenCanvas,
}: PlaygroundEmptyStateProps) {
  const { t } = useTranslation()
  const greeting = openingMessage.trim()
  const questions = suggestedQuestions.filter((question) => question.trim())
  const featureCards = [
    {
      icon: SlidersHorizontal,
      title: t('Model parameters'),
      description: t(
        'Control sampling, token limits and reasoning for the next request.'
      ),
      onSelect: onOpenParameters,
    },
    {
      icon: Bot,
      title: t('Assistant presets'),
      description: t('Reuse a saved model, prompt and parameter set.'),
      onSelect: onOpenPresets,
    },
    {
      icon: Brain,
      title: t('Memory'),
      description: t(
        'Keep durable notes the assistant can reuse across conversations.'
      ),
      onSelect: onOpenMemory,
    },
    {
      icon: Images,
      title: t('Generate media'),
      description: t('Open the canvas generation panel for images and video.'),
      onSelect: onOpenCanvas,
    },
  ].filter((card) => card.onSelect !== undefined)

  return (
    <div className='flex min-h-[min(520px,calc(100svh-18rem))] items-center justify-center px-1 py-8 md:py-12'>
      <div className='grid w-full max-w-2xl gap-5 text-center'>
        <div className='bg-muted/50 text-muted-foreground mx-auto flex size-11 items-center justify-center rounded-xl border'>
          <MessageSquarePlusIcon className='size-5' aria-hidden='true' />
        </div>

        <div className='grid gap-2'>
          <h2 className='text-xl font-semibold tracking-tight text-balance md:text-2xl'>
            {t('Start a playground chat')}
          </h2>
          <p className='text-muted-foreground mx-auto max-w-lg text-sm leading-6 text-balance'>
            {t(
              'Test a model with a starter prompt, or write your own request below.'
            )}
          </p>
        </div>

        {noAvailableModels && <PlaygroundNoModelsNotice />}

        {greeting && (
          <div className='bg-muted/30 rounded-xl border p-4 text-left text-sm leading-6 break-words whitespace-pre-wrap'>
            {greeting}
          </div>
        )}

        {questions.length > 0 && (
          <div className='grid gap-2 text-left'>
            <p className='text-muted-foreground text-xs font-medium'>
              {t('Suggested questions')}
            </p>
            <div className='grid gap-2 sm:grid-cols-2'>
              {questions.map((question) => (
                <Button
                  className='h-auto min-h-11 justify-start px-3 py-2.5 text-left whitespace-normal'
                  key={question}
                  onClick={() => onSelectPrompt(question)}
                  variant='outline'
                >
                  <span>{question}</span>
                </Button>
              ))}
            </div>
          </div>
        )}

        {questions.length === 0 && (
          <div className='grid gap-2 sm:grid-cols-2'>
            {starterPrompts.map(({ icon: Icon, text }) => {
              const prompt = t(text)

              return (
                <Button
                  className='h-auto min-h-11 justify-start gap-2 px-3 py-2.5 text-left whitespace-normal'
                  key={text}
                  onClick={() => onSelectPrompt(prompt)}
                  variant='outline'
                >
                  <Icon className='text-muted-foreground size-4' />
                  <span>{prompt}</span>
                </Button>
              )
            })}
          </div>
        )}

        {showFeatureCards && featureCards.length > 0 && (
          <div className='grid gap-2 text-left'>
            <p className='text-muted-foreground text-xs font-medium'>
              {t('Explore the workspace')}
            </p>
            <div className='grid gap-2 sm:grid-cols-2'>
              {featureCards.map(
                ({ icon: Icon, title, description, onSelect }) => (
                  <Button
                    className='h-auto min-h-16 items-start justify-start gap-2.5 px-3 py-2.5 text-left whitespace-normal'
                    key={title}
                    onClick={() => onSelect?.()}
                    variant='outline'
                  >
                    <Icon className='text-muted-foreground mt-0.5 size-4 shrink-0' />
                    <span className='grid gap-0.5'>
                      <span className='text-sm font-medium'>{title}</span>
                      <span className='text-muted-foreground text-xs leading-5 font-normal'>
                        {description}
                      </span>
                    </span>
                  </Button>
                )
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
