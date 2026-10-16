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
  Check,
  ChevronLeft,
  Clock3,
  Download,
  Eye,
  FileCode2,
  FileText,
  Pencil,
  RotateCcw,
  Trash2,
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  Artifact,
  ArtifactAction,
  ArtifactActions,
  ArtifactContent,
  ArtifactHeader,
  ArtifactTitle,
} from '@/components/ai-elements/artifact'
import { CodeBlock, CodeBlockEditor } from '@/components/ai-elements/code-block'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { CopyButton } from '@/components/copy-button'
import { ErrorState } from '@/components/error-state'
import { LoadingState } from '@/components/loading-state'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Markdown } from '@/components/ui/markdown'
import { ScrollArea } from '@/components/ui/scroll-area'
import { getServerMessage } from '@/lib/server-error-message'

import type { PlaygroundArtifactResult } from '../../artifact-api'
import type {
  ArtifactDraft,
  usePlaygroundArtifacts,
} from '../../hooks/use-playground-artifacts'
import { downloadArtifactText } from '../../lib/artifact-utils'

type ArtifactController = ReturnType<typeof usePlaygroundArtifacts>

interface PlaygroundArtifactPanelProps {
  controller: ArtifactController
  onClose: () => void
}

export function PlaygroundArtifactPanel(props: PlaygroundArtifactPanelProps) {
  const { t } = useTranslation()
  const controller = props.controller
  const state = controller.state
  const [artifactToDelete, setArtifactToDelete] = useState(false)
  const [reloadConfirmation, setReloadConfirmation] = useState(false)
  const selectedSummary = controller.artifacts.find(
    (artifact) => artifact.id === state.selectedArtifactId
  )
  const selectedVersion = state.selectedVersionId
    ? (controller.viewedVersion?.version ?? null)
    : (controller.detail?.version ?? null)
  const displayedDraft: ArtifactDraft | null =
    state.selectedVersionId && selectedVersion && selectedSummary
      ? {
          kind: selectedSummary.kind,
          title: selectedVersion.title,
          language: selectedVersion.language,
          content: selectedVersion.content,
        }
      : state.draft
  const readOnlyHistory = state.selectedVersionId !== null
  const draft = state.draft

  const closeSafely = () => {
    if (state.dirty) {
      state.requestDiscard(props.onClose)
      return
    }
    props.onClose()
  }

  const selectArtifact = (id: string | null) => {
    if (state.dirty && id !== state.selectedArtifactId) {
      state.requestDiscard(() => state.selectArtifact(id))
      return
    }
    state.selectArtifact(id)
  }

  const saveAsFile = () => {
    if (!displayedDraft) return
    downloadArtifactText(
      displayedDraft.title,
      displayedDraft.language,
      displayedDraft.kind,
      displayedDraft.content
    )
  }

  return (
    <Artifact className='size-full min-h-0 rounded-none border-0 shadow-none'>
      <ArtifactHeader className='shrink-0 gap-2 px-3 py-2'>
        <div className='flex min-w-0 items-center gap-2'>
          {state.selectedArtifactId && (
            <Button
              aria-label={t('Back to artifacts')}
              onClick={() => selectArtifact(null)}
              size='icon-sm'
              type='button'
              variant='ghost'
            >
              <ChevronLeft aria-hidden='true' />
            </Button>
          )}
          {displayedDraft?.kind === 'code' ? (
            <FileCode2 aria-hidden='true' className='size-4 shrink-0' />
          ) : (
            <FileText aria-hidden='true' className='size-4 shrink-0' />
          )}
          <ArtifactTitle className='truncate'>
            {displayedDraft?.title ?? t('Artifacts')}
          </ArtifactTitle>
          {state.dirty && (
            <span className='text-warning text-xs'>{t('Unsaved changes')}</span>
          )}
          {readOnlyHistory && selectedVersion && (
            <span className='text-muted-foreground text-xs'>
              {t('Version {{number}}', { number: selectedVersion.number })}
            </span>
          )}
        </div>
        <ArtifactActions>
          {displayedDraft && (
            <CopyButton
              value={displayedDraft.content}
              aria-label={t('Copy artifact content')}
              tooltip={t('Copy artifact content')}
            />
          )}
          {displayedDraft && (
            <ArtifactAction
              label={t('Download artifact')}
              tooltip={t('Download artifact')}
              icon={Download}
              onClick={saveAsFile}
            />
          )}
          {state.selectedArtifactId && !readOnlyHistory && (
            <ArtifactAction
              label={t('Delete artifact')}
              tooltip={t('Delete artifact')}
              icon={Trash2}
              disabled={state.dirty || controller.isSaving}
              onClick={() => setArtifactToDelete(true)}
            />
          )}
          <ArtifactAction
            label={t('Close')}
            tooltip={t('Close')}
            onClick={closeSafely}
          />
        </ArtifactActions>
      </ArtifactHeader>

      <div className='flex min-h-0 flex-1 overflow-hidden'>
        <aside className='bg-muted/10 flex w-44 shrink-0 flex-col border-r sm:w-56'>
          <div className='border-b px-3 py-2 text-xs font-medium'>
            {t('Saved artifacts')}
          </div>
          <ScrollArea className='min-h-0 flex-1'>
            <div className='grid gap-1 p-2'>
              {controller.isLoading && <LoadingState className='min-h-24' />}
              {controller.artifacts.map((artifact) => (
                <Button
                  aria-current={
                    artifact.id === state.selectedArtifactId
                      ? 'true'
                      : undefined
                  }
                  className='h-auto min-w-0 justify-start px-2 py-2 text-left whitespace-normal'
                  key={artifact.id}
                  onClick={() => selectArtifact(artifact.id)}
                  type='button'
                  variant={
                    artifact.id === state.selectedArtifactId
                      ? 'secondary'
                      : 'ghost'
                  }
                >
                  {artifact.kind === 'markdown' ? (
                    <FileText aria-hidden='true' className='size-4 shrink-0' />
                  ) : (
                    <FileCode2 aria-hidden='true' className='size-4 shrink-0' />
                  )}
                  <span className='grid min-w-0 text-start'>
                    <span className='truncate'>{artifact.title}</span>
                    <span className='text-muted-foreground text-xs'>
                      {t('Version {{number}}', { number: artifact.revision })}
                    </span>
                  </span>
                </Button>
              ))}
              {!controller.isLoading && controller.artifacts.length === 0 && (
                <p className='text-muted-foreground px-2 py-5 text-center text-xs'>
                  {t(
                    'Artifacts created from assistant responses will appear here.'
                  )}
                </p>
              )}
            </div>
          </ScrollArea>
        </aside>

        <div className='flex min-h-0 min-w-0 flex-1 flex-col'>
          {controller.error && (
            <div className='shrink-0 p-2'>
              <ErrorState
                className='min-h-0 p-2'
                title={t('Unable to load or save Playground artifacts.')}
                description={getServerMessage(controller.error)}
                onRetry={controller.retry}
              />
            </div>
          )}
          {state.selectedArtifactId && !displayedDraft && (
            <LoadingState className='min-h-0 flex-1' />
          )}
          {!state.selectedArtifactId && (
            <div className='text-muted-foreground flex min-h-0 flex-1 items-center justify-center p-6 text-center text-sm'>
              {t('Choose a saved artifact to edit it or view its history.')}
            </div>
          )}
          {state.selectedArtifactId && displayedDraft && (
            <>
              <div className='flex flex-wrap items-center gap-2 border-b p-2'>
                {!readOnlyHistory && draft && (
                  <>
                    <Input
                      aria-label={t('Artifact title')}
                      className='min-w-28 flex-1'
                      maxLength={200}
                      onChange={(event) =>
                        state.updateDraft({
                          ...draft,
                          title: event.target.value,
                        })
                      }
                      value={draft.title}
                    />
                    {draft.kind === 'code' && (
                      <Input
                        aria-label={t('Code language')}
                        className='w-28'
                        maxLength={32}
                        onChange={(event) =>
                          state.updateDraft({
                            ...draft,
                            language: event.target.value,
                          })
                        }
                        value={draft.language}
                      />
                    )}
                    <Button
                      disabled={
                        !state.dirty ||
                        controller.isSaving ||
                        !draft.title.trim()
                      }
                      onClick={() => void controller.saveDraft()}
                      type='button'
                    >
                      {controller.isSaving ? (
                        <Clock3 aria-hidden='true' />
                      ) : (
                        <Check aria-hidden='true' />
                      )}
                      {t('Save version')}
                    </Button>
                  </>
                )}
                {readOnlyHistory && (
                  <>
                    <Button
                      onClick={() => state.selectVersion(null)}
                      type='button'
                      variant='outline'
                    >
                      <Pencil aria-hidden='true' />
                      {t('Return to draft')}
                    </Button>
                    <Button
                      disabled={controller.isSaving || state.dirty}
                      onClick={() => void controller.restoreVersion()}
                      type='button'
                    >
                      <RotateCcw aria-hidden='true' />
                      {t('Restore as new version')}
                    </Button>
                  </>
                )}
                {controller.conflict && (
                  <Button
                    onClick={() => setReloadConfirmation(true)}
                    type='button'
                    variant='outline'
                  >
                    {t('Reload server version')}
                  </Button>
                )}
                {controller.error && (
                  <Button
                    disabled={controller.isSaving}
                    onClick={() =>
                      void (state.pendingSave
                        ? controller.saveDraft()
                        : controller.retryCreate())
                    }
                    type='button'
                    variant='outline'
                  >
                    {t('Retry same request')}
                  </Button>
                )}
              </div>
              <div
                aria-label={t('Artifact version history')}
                className='flex shrink-0 gap-1 overflow-x-auto border-b px-2 py-1.5'
                role='list'
              >
                {controller.versions.map((version) => (
                  <Button
                    aria-pressed={version.id === state.selectedVersionId}
                    key={version.id}
                    onClick={() =>
                      state.selectVersion(
                        version.id === state.selectedVersionId
                          ? null
                          : version.id
                      )
                    }
                    size='sm'
                    type='button'
                    variant={
                      version.id === state.selectedVersionId
                        ? 'secondary'
                        : 'ghost'
                    }
                  >
                    v{version.number} · {version.title}
                  </Button>
                ))}
              </div>
              <ArtifactContent className='min-h-0 p-3 sm:p-4'>
                <ArtifactBody
                  draft={draft}
                  kind={displayedDraft.kind}
                  onChange={state.updateDraft}
                  readOnlyHistory={readOnlyHistory}
                  selectedVersion={selectedVersion}
                />
              </ArtifactContent>
            </>
          )}
        </div>
      </div>

      <ConfirmDialog
        confirmText={t('Discard changes')}
        cancelBtnText={t('Keep editing')}
        desc={t(
          'Your unsaved artifact draft will be discarded from this page.'
        )}
        destructive
        handleConfirm={state.discardAndContinue}
        onOpenChange={(open) => {
          if (!open) state.cancelDiscard()
        }}
        open={state.showDiscardConfirmation}
        title={t('Discard artifact changes?')}
      />
      <ConfirmDialog
        confirmText={t('Delete artifact')}
        destructive
        handleConfirm={() => {
          void controller.deleteArtifact().then((deleted) => {
            if (deleted) setArtifactToDelete(false)
          })
        }}
        onOpenChange={setArtifactToDelete}
        open={artifactToDelete}
        title={t('Delete artifact?')}
        desc={t('All saved versions of this artifact will be deleted.')}
      />
      <ConfirmDialog
        confirmText={t('Reload server version')}
        destructive
        handleConfirm={() => {
          setReloadConfirmation(false)
          void controller.reloadHead()
        }}
        onOpenChange={setReloadConfirmation}
        open={reloadConfirmation}
        title={t('Reload artifact?')}
        desc={t(
          'Local edits will be discarded and the latest server version will be loaded.'
        )}
      />
    </Artifact>
  )
}

function MarkdownEditor(props: {
  draft: ArtifactDraft
  onChange: (draft: ArtifactDraft) => void
}) {
  const { t } = useTranslation()
  const [preview, setPreview] = useState(false)
  return preview ? (
    <div className='grid gap-3'>
      <Button
        className='w-fit'
        onClick={() => setPreview(false)}
        size='sm'
        type='button'
        variant='outline'
      >
        <Pencil aria-hidden='true' />
        {t('Edit artifact')}
      </Button>
      <Markdown>{props.draft.content}</Markdown>
    </div>
  ) : (
    <div className='grid min-h-0 gap-2'>
      <Button
        className='w-fit'
        onClick={() => setPreview(true)}
        size='sm'
        type='button'
        variant='outline'
      >
        <Eye aria-hidden='true' />
        {t('Preview artifact')}
      </Button>
      <CodeBlockEditor
        ariaLabel={t('Artifact content')}
        autoFocus={false}
        language='markdown'
        onChange={(content) => props.onChange({ ...props.draft, content })}
        rows={16}
        value={props.draft.content}
      />
    </div>
  )
}

function ArtifactBody(props: {
  draft: ArtifactDraft | null
  kind: 'markdown' | 'code'
  onChange: (draft: ArtifactDraft) => void
  readOnlyHistory: boolean
  selectedVersion: PlaygroundArtifactResult['version'] | null
}) {
  const { t } = useTranslation()
  if (props.readOnlyHistory) {
    if (!props.selectedVersion) {
      return <LoadingState />
    }
    return <VersionPreview version={props.selectedVersion} kind={props.kind} />
  }
  if (props.draft?.kind === 'markdown') {
    return <MarkdownEditor draft={props.draft} onChange={props.onChange} />
  }
  if (props.draft) {
    const draft = props.draft
    return (
      <CodeBlockEditor
        ariaLabel={t('Artifact content')}
        autoFocus={false}
        language={draft.language || 'plaintext'}
        onChange={(content) => props.onChange({ ...draft, content })}
        rows={16}
        value={draft.content}
      />
    )
  }
  return <LoadingState />
}

function VersionPreview(props: {
  version: PlaygroundArtifactResult['version']
  kind: 'markdown' | 'code'
}) {
  return props.kind === 'markdown' ? (
    <Markdown>{props.version.content}</Markdown>
  ) : (
    <CodeBlock
      code={props.version.content}
      language={props.version.language || 'plaintext'}
      showToolbar
      title={props.version.title}
    />
  )
}
