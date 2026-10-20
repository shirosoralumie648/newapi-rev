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
import type { TFunction } from 'i18next'

import type { CanvasInspectorView } from '@/features/canvas/types'
import { formatShortcutHint } from '@/lib/shortcuts'

import { PLAYGROUND_PROTOCOL_OPTIONS } from '../../constants'
import type {
  ModelOption,
  PlaygroundExportFormat,
  PlaygroundProtocol,
  PlaygroundSession,
} from '../../types'
import { isChatModelOption } from '../options/playground-option-utils'
import {
  PLAYGROUND_MESSAGE_JUMP_BINDING,
  PLAYGROUND_MESSAGE_SEARCH_BINDING,
} from '../shortcuts/playground-shortcuts'

export type PlaygroundCommandGroup =
  | 'workspace'
  | 'inspector'
  | 'canvas'
  | 'models'
  | 'conversations'
  | 'protocol'
  | 'help'

export const PLAYGROUND_COMMAND_GROUP_ORDER: readonly PlaygroundCommandGroup[] =
  [
    'workspace',
    'inspector',
    'canvas',
    'models',
    'conversations',
    'protocol',
    'help',
  ]

export const PLAYGROUND_COMMAND_GROUP_LABELS: Record<
  PlaygroundCommandGroup,
  string
> = {
  workspace: 'Workspace',
  inspector: 'Inspector',
  canvas: 'Canvas',
  models: 'Models',
  conversations: 'Conversations',
  protocol: 'Protocol',
  help: 'Help',
}

export interface PlaygroundCommand {
  /** Stable identity for rendering and tests. */
  id: string
  group: PlaygroundCommandGroup
  /** Localized title shown in the palette. */
  title: string
  /** Extra text the fuzzy matcher may score, without showing it. */
  keywords?: string
  /** Right-aligned chord hint of the current platform. */
  shortcut?: string
  /** Search results stay out of the empty-query list. */
  searchOnly?: boolean
  run: () => void
}

export interface PlaygroundCommandSection {
  group: PlaygroundCommandGroup
  heading: string
  commands: PlaygroundCommand[]
}

export type PlaygroundCommandInspectorView =
  | 'presets'
  | 'memory'
  | 'trash'
  | 'usage'

export interface PlaygroundCommandActions {
  newConversation: () => void
  switchSession: (sessionId: string) => void
  useModel: (model: string) => void
  openInspector: (view: PlaygroundCommandInspectorView) => void
  openCanvas: (view: CanvasInspectorView) => void
  switchProtocol: (protocol: PlaygroundProtocol) => void
  exportSession: (format: PlaygroundExportFormat) => void
  openMessageSearch: () => void
  openMessageJump: () => void
  openShortcuts: () => void
}

export interface PlaygroundCommandContext {
  t: TFunction
  sessions: readonly PlaygroundSession[]
  models: readonly ModelOption[]
  activeSessionId: string | null
  protocol: PlaygroundProtocol
  /** Whether the active conversation is persisted and can be exported. */
  canExport: boolean
  actions: PlaygroundCommandActions
}

/** Builds every palette command of the current workspace state. */
export function buildPlaygroundCommands(
  context: PlaygroundCommandContext
): PlaygroundCommand[] {
  const { actions, t } = context
  const commands: PlaygroundCommand[] = [
    {
      id: 'new-conversation',
      group: 'workspace',
      title: t('New conversation'),
      keywords: 'session chat',
      run: actions.newConversation,
    },
    {
      id: 'search-messages',
      group: 'workspace',
      title: t('Search messages'),
      keywords: 'find text conversation',
      shortcut: formatShortcutHint(PLAYGROUND_MESSAGE_SEARCH_BINDING),
      run: actions.openMessageSearch,
    },
    {
      id: 'jump-to-message',
      group: 'workspace',
      title: t('Jump to message'),
      keywords: 'index navigate conversation',
      shortcut: formatShortcutHint(PLAYGROUND_MESSAGE_JUMP_BINDING),
      run: actions.openMessageJump,
    },
    {
      id: 'open-presets',
      group: 'inspector',
      title: t('Open assistant presets'),
      keywords: 'presets assistants templates',
      run: () => actions.openInspector('presets'),
    },
    {
      id: 'open-memory',
      group: 'inspector',
      title: t('Open memory'),
      keywords: 'notes durable',
      run: () => actions.openInspector('memory'),
    },
    {
      id: 'open-trash',
      group: 'inspector',
      title: t('Open trash'),
      keywords: 'deleted restore',
      run: () => actions.openInspector('trash'),
    },
    {
      id: 'open-usage',
      group: 'inspector',
      title: t('Open usage analytics'),
      keywords: 'spend tokens cost',
      run: () => actions.openInspector('usage'),
    },
    {
      id: 'open-canvas',
      group: 'canvas',
      title: t('Open canvas'),
      keywords: 'board nodes',
      run: () => actions.openCanvas('details'),
    },
    {
      id: 'open-artifacts',
      group: 'canvas',
      title: t('Open artifacts'),
      keywords: 'artifact preview code',
      run: () => actions.openCanvas('artifacts'),
    },
    {
      id: 'open-asset-library',
      group: 'canvas',
      title: t('Open asset library'),
      keywords: 'assets attachments',
      run: () => actions.openCanvas('library'),
    },
    {
      id: 'open-generation',
      group: 'canvas',
      title: t('Open generation'),
      keywords: 'image video task',
      run: () => actions.openCanvas('generate'),
    },
    {
      id: 'open-run-history',
      group: 'canvas',
      title: t('Open run history'),
      keywords: 'workflow runs cache',
      run: () => actions.openCanvas('history'),
    },
    {
      id: 'open-canvas-assistant',
      group: 'canvas',
      title: t('Open canvas assistant'),
      keywords: 'agent compose',
      run: () => actions.openCanvas('assistant'),
    },
    {
      id: 'open-shortcuts',
      group: 'help',
      title: t('Keyboard shortcuts'),
      keywords: 'keys help bindings',
      shortcut: '?',
      run: actions.openShortcuts,
    },
  ]

  if (context.canExport) {
    commands.push(
      {
        id: 'export-markdown',
        group: 'workspace',
        title: t('Export as Markdown'),
        keywords: 'download conversation',
        run: () => actions.exportSession('markdown'),
      },
      {
        id: 'export-json',
        group: 'workspace',
        title: t('Export as JSON'),
        keywords: 'download conversation',
        run: () => actions.exportSession('json'),
      }
    )
  }

  const activeSessionId = context.activeSessionId
  for (const session of [...context.sessions].sort(
    (first, second) => second.updatedAt - first.updatedAt
  )) {
    if (session.id === activeSessionId) continue
    const title = session.title || t('Untitled conversation')
    commands.push({
      id: `switch-session:${session.id}`,
      group: 'conversations',
      title: t('Switch to {{title}}', { title }),
      keywords: `${session.title} ${session.tags.join(' ')}`,
      searchOnly: true,
      run: () => actions.switchSession(session.id),
    })
  }

  for (const model of context.models.filter(isChatModelOption)) {
    const label = model.label || model.value
    commands.push({
      id: `use-model:${model.value}`,
      group: 'models',
      title: t('Use model {{model}}', { model: label }),
      keywords: `${model.value} ${model.category ?? ''}`,
      searchOnly: true,
      run: () => actions.useModel(model.value),
    })
  }

  for (const option of PLAYGROUND_PROTOCOL_OPTIONS) {
    if (option.value === context.protocol) continue
    commands.push({
      id: `switch-protocol:${option.value}`,
      group: 'protocol',
      title: t('Switch to {{protocol}}', { protocol: t(option.labelKey) }),
      keywords: option.value,
      run: () => actions.switchProtocol(option.value),
    })
  }

  return commands
}

/** Scores one command for a query; `null` means it does not match. */
export function scorePlaygroundCommand(
  query: string,
  command: PlaygroundCommand
): number | null {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return 0
  const titleScore = fuzzyScore(needle, command.title)
  const keywordScore = command.keywords
    ? fuzzyScore(needle, command.keywords)
    : null
  if (titleScore === null) return keywordScore
  if (keywordScore === null) return titleScore
  return Math.max(titleScore, keywordScore)
}

/**
 * Substring, prefix and word-boundary matches outrank a sparse subsequence.
 * The returned score is only a ranking signal, never displayed.
 */
function fuzzyScore(needle: string, text: string): number | null {
  const haystack = text.toLocaleLowerCase()
  const index = haystack.indexOf(needle)
  if (index === 0) return 1000 - haystack.length * 0.01
  if (index > 0) {
    const boundary = !/[a-z0-9]/.test(haystack[index - 1] ?? '')
    return (boundary ? 800 : 500) - index
  }
  let cursor = 0
  let gaps = 0
  let previous = -1
  for (const character of needle) {
    const found = haystack.indexOf(character, cursor)
    if (found === -1) return null
    if (previous >= 0) gaps += found - previous - 1
    previous = found
    cursor = found + 1
  }
  return 100 - gaps
}

/**
 * Applies the palette rules: an empty query lists actions only, a query adds
 * the searchable sessions and models and ranks every match by the best score.
 */
export function filterPlaygroundCommands(
  commands: readonly PlaygroundCommand[],
  query: string
): PlaygroundCommand[] {
  const hasQuery = query.trim() !== ''
  const scored: { command: PlaygroundCommand; score: number }[] = []
  for (const command of commands) {
    if (!hasQuery && command.searchOnly) continue
    const score = scorePlaygroundCommand(query, command)
    if (score === null) continue
    scored.push({ command, score })
  }
  if (!hasQuery) return scored.map((entry) => entry.command)
  return scored
    .sort((first, second) => second.score - first.score)
    .map((entry) => entry.command)
}

/** Buckets commands into the fixed group order of the palette. */
export function groupPlaygroundCommands(
  commands: readonly PlaygroundCommand[],
  t: (key: string) => string
): PlaygroundCommandSection[] {
  return PLAYGROUND_COMMAND_GROUP_ORDER.map((group) => ({
    group,
    heading: t(PLAYGROUND_COMMAND_GROUP_LABELS[group]),
    commands: commands.filter((command) => command.group === group),
  })).filter((section) => section.commands.length > 0)
}
