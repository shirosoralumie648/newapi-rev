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
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'
import { toIntlLocale } from '@/i18n/languages'
import { formatNumber } from '@/lib/format'

import { PLAYGROUND_ARENA_NOTE_MAX_LENGTH } from '../../constants'
import type {
  PlaygroundArenaChoice,
  PlaygroundArenaVote,
  PlaygroundArenaVoteSummary,
} from '../../types'

type PlaygroundArenaVoteBarProps = {
  disabled?: boolean
  /** The caller's stored vote for this message group, when one exists. */
  vote?: PlaygroundArenaVote
  personalSummary?: PlaygroundArenaVoteSummary
  /** Present only for administrators; enables the instance scope tab. */
  instanceSummary?: PlaygroundArenaVoteSummary
  onVote?: (choice: PlaygroundArenaChoice, note: string) => Promise<void> | void
}

const ARENA_CHOICES: PlaygroundArenaChoice[] = ['a', 'b', 'tie', 'both_bad']

const ARENA_CHOICE_LABELS: Record<PlaygroundArenaChoice, string> = {
  a: 'A better',
  b: 'B better',
  tie: 'Tie',
  both_bad: 'Both bad',
}

/**
 * Raw preference vote of one anonymous A/B group. All four choices are always
 * available, an optional note travels with the chosen preference, and a repeat
 * or change updates the caller's single stored vote. The read-only summary
 * shows personal totals and, for administrators, instance totals.
 */
export function PlaygroundArenaVoteBar(props: PlaygroundArenaVoteBarProps) {
  const { t, i18n } = useTranslation()
  const locale = toIntlLocale(i18n.resolvedLanguage || i18n.language)
  const [note, setNote] = useState(props.vote?.note ?? '')
  const [saving, setSaving] = useState(false)
  const [scope, setScope] = useState<'personal' | 'instance'>('personal')

  useEffect(() => {
    setNote(props.vote?.note ?? '')
  }, [props.vote?.note])

  const summary =
    scope === 'instance' && props.instanceSummary
      ? props.instanceSummary
      : props.personalSummary
  const counts: Record<PlaygroundArenaChoice, number> = {
    a: summary?.choices.a ?? 0,
    b: summary?.choices.b ?? 0,
    tie: summary?.choices.tie ?? 0,
    both_bad: summary?.choices.bothBad ?? 0,
  }
  const disabled = props.disabled === true || saving || !props.onVote
  const canSaveNote =
    Boolean(props.vote) && note.trim() !== (props.vote?.note ?? '')

  const submit = async (choice: PlaygroundArenaChoice) => {
    if (disabled || !props.onVote) return
    setSaving(true)
    try {
      await props.onVote(choice, note.trim())
    } catch {
      // The mutation reports the failure through the shared error handler; the
      // note stays in the textarea so the reader can retry.
    } finally {
      setSaving(false)
    }
  }

  const saveNote = async () => {
    if (!props.vote) return
    await submit(props.vote.choice)
  }

  return (
    <section
      aria-label={t('Preference vote')}
      className='border-border/60 bg-muted/20 flex flex-col gap-2 rounded-lg border px-3 py-2.5'
    >
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <span className='text-sm font-medium'>
          {t('Which reply is better?')}
        </span>
        {summary ? (
          <Popover>
            <PopoverTrigger
              render={
                <Button size='sm' type='button' variant='ghost'>
                  {t('Vote summary')}
                </Button>
              }
            />
            <PopoverContent align='end' className='w-64 gap-2'>
              <PopoverTitle className='text-xs'>
                {t('Vote summary')}
              </PopoverTitle>
              {props.instanceSummary ? (
                <div className='flex gap-1'>
                  <Button
                    aria-pressed={scope === 'personal'}
                    onClick={() => setScope('personal')}
                    size='sm'
                    type='button'
                    variant={scope === 'personal' ? 'secondary' : 'ghost'}
                  >
                    {t('Your votes')}
                  </Button>
                  <Button
                    aria-pressed={scope === 'instance'}
                    onClick={() => setScope('instance')}
                    size='sm'
                    type='button'
                    variant={scope === 'instance' ? 'secondary' : 'ghost'}
                  >
                    {t('Instance votes')}
                  </Button>
                </div>
              ) : null}
              <div className='flex flex-col gap-0.5 text-xs'>
                {ARENA_CHOICES.map((choice) => (
                  <div
                    className='flex items-baseline justify-between gap-3'
                    key={choice}
                  >
                    <span className='text-muted-foreground'>
                      {t(ARENA_CHOICE_LABELS[choice])}
                    </span>
                    <span className='tabular-nums'>
                      {formatNumber(counts[choice], locale)}
                    </span>
                  </div>
                ))}
                <div className='flex items-baseline justify-between gap-3'>
                  <span className='text-muted-foreground'>{t('Notes')}</span>
                  <span className='tabular-nums'>
                    {formatNumber(summary.notes, locale)}
                  </span>
                </div>
              </div>
              <PopoverDescription className='text-[11px]'>
                {summary.total === 0
                  ? t('No votes yet.')
                  : t('Total votes: {{count}}', {
                      count: formatNumber(summary.total, locale),
                    })}
              </PopoverDescription>
            </PopoverContent>
          </Popover>
        ) : null}
      </div>

      <div
        aria-label={t('Vote on this comparison')}
        className='flex flex-wrap gap-1.5'
        role='group'
      >
        {ARENA_CHOICES.map((choice) => (
          <Button
            aria-pressed={props.vote?.choice === choice}
            className='flex-1'
            disabled={disabled}
            key={choice}
            onClick={() => void submit(choice)}
            size='sm'
            type='button'
            variant={props.vote?.choice === choice ? 'secondary' : 'outline'}
          >
            {t(ARENA_CHOICE_LABELS[choice])}
          </Button>
        ))}
      </div>

      <div className='flex items-end gap-2'>
        <Textarea
          aria-label={t('Vote note')}
          className='min-h-8 flex-1 resize-none text-sm'
          maxLength={PLAYGROUND_ARENA_NOTE_MAX_LENGTH}
          onChange={(event) => setNote(event.target.value)}
          placeholder={t('Add a one-sentence note (optional)')}
          rows={1}
          value={note}
        />
        {props.vote && canSaveNote ? (
          <Button
            disabled={disabled}
            onClick={() => void saveNote()}
            size='sm'
            type='button'
            variant='outline'
          >
            {t('Save note')}
          </Button>
        ) : null}
      </div>
    </section>
  )
}
