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
import { Plus, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { FormItem } from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

import {
  SettingsForm,
  SettingsFormGrid,
  SettingsSwitchField,
} from '../components/settings-form-layout'
import { SettingsPageFormActions } from '../components/settings-page-context'
import { SettingsSection } from '../components/settings-section'
import { useUpdatePlaygroundMCP } from '../hooks/use-update-option'
import {
  createPlaygroundMCPDraftRowId,
  findPlaygroundMCPDraftErrors,
  parsePlaygroundMCP,
  serializePlaygroundMCP,
  PLAYGROUND_MCP_DEFAULT_AUTH_HEADER,
  PLAYGROUND_MCP_MAX_HEADER_NAME_BYTES,
  PLAYGROUND_MCP_MAX_SERVERS,
  PLAYGROUND_MCP_MAX_SERVER_NAME_RUNES,
  PLAYGROUND_MCP_MAX_TOKEN_BYTES,
  PLAYGROUND_MCP_MAX_URL_BYTES,
  type PlaygroundMCPDraft,
  type PlaygroundMCPServerDraft,
} from './playground-mcp-fields'

type PlaygroundMCPSectionProps = {
  mcpJson: string
}

function newMCPServerDraft(): PlaygroundMCPServerDraft {
  return {
    rowId: createPlaygroundMCPDraftRowId(),
    id: '',
    name: '',
    url: '',
    enabled: true,
    header: PLAYGROUND_MCP_DEFAULT_AUTH_HEADER,
    token: '',
    hasToken: false,
    clearToken: false,
  }
}

function tokenHint(server: PlaygroundMCPServerDraft): string {
  if (server.clearToken) return 'The stored token is removed when you save.'
  if (server.hasToken) return 'A token is stored on the server.'
  return 'Sent to the connection only, never returned to the browser.'
}

/**
 * Administrator-managed list of global streamable HTTP MCP connections. The
 * gateway stores the endpoints and credentials; the account console receives
 * only ids, names and tool metadata. Saving is atomic: the whole list and its
 * replacement credentials travel together, and a blank token keeps the stored
 * one until an explicit removal.
 */
export function PlaygroundMCPSection(props: PlaygroundMCPSectionProps) {
  const { t } = useTranslation()
  const updateMCP = useUpdatePlaygroundMCP()
  const baseline = useMemo(
    () => parsePlaygroundMCP(props.mcpJson),
    [props.mcpJson]
  )
  const baselineJson = useMemo(
    () => serializePlaygroundMCP(baseline),
    [baseline]
  )
  const [draft, setDraft] = useState<PlaygroundMCPDraft>(() => baseline)
  const [errors, setErrors] = useState<Record<string, string>>({})

  useEffect(() => {
    setDraft(parsePlaygroundMCP(props.mcpJson))
    setErrors({})
  }, [props.mcpJson])

  const updateServer = (
    index: number,
    patch: Partial<PlaygroundMCPServerDraft>
  ) => {
    setDraft((current) => ({
      ...current,
      servers: current.servers.map((server, position) =>
        position === index ? { ...server, ...patch } : server
      ),
    }))
  }

  const handleAdd = () => {
    if (draft.servers.length >= PLAYGROUND_MCP_MAX_SERVERS) return
    setDraft((current) => ({
      ...current,
      servers: [...current.servers, newMCPServerDraft()],
    }))
  }

  const handleSave = async () => {
    const nextErrors = findPlaygroundMCPDraftErrors(draft)
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) return
    const serialized = serializePlaygroundMCP(draft)
    if (serialized === baselineJson) {
      toast.info(t('No changes to save'))
      return
    }
    try {
      await updateMCP.mutateAsync({ mcp: serialized })
    } catch {
      // The mutation already surfaced the failure; keep the draft for retry.
    }
  }

  return (
    <SettingsSection title={t('Playground MCP Tools')}>
      <SettingsForm
        onSubmit={(event) => {
          event.preventDefault()
          void handleSave()
        }}
      >
        <SettingsPageFormActions
          isSaving={updateMCP.isPending}
          onSave={() => void handleSave()}
          saveLabel='Save MCP settings'
        />

        <div className='space-y-6'>
          <div className='space-y-1'>
            <p className='text-muted-foreground text-sm'>
              {t(
                'The gateway proxies every call, so endpoints and credentials never reach the browser. Enabling the feature requires at least one enabled connection.'
              )}
            </p>
          </div>

          <SettingsSwitchField
            controlId='playground-mcp-enabled'
            checked={draft.enabled}
            onCheckedChange={(checked) =>
              setDraft((current) => ({ ...current, enabled: checked }))
            }
            label={t('Enable MCP tools for Playground')}
            description={t(
              'Show the MCP switch in the composer. Accounts decide for themselves whether the enabled connections are offered to the model.'
            )}
          />

          <div className='space-y-4'>
            <div className='space-y-1'>
              <h3 className='text-base font-medium'>{t('Connections')}</h3>
              <p className='text-muted-foreground text-sm'>
                {t(
                  'Each connection is a streamable HTTP MCP endpoint. An optional token is sent with the configured header only.'
                )}
              </p>
            </div>

            {errors.servers && (
              <p className='text-destructive text-sm'>{t(errors.servers)}</p>
            )}

            {draft.servers.map((server, index) => {
              const prefix = `server-${index}`
              return (
                <div
                  className='space-y-4 rounded-lg border p-4'
                  key={server.rowId}
                >
                  <SettingsSwitchField
                    controlId={`playground-mcp-server-${index}-enabled`}
                    checked={server.enabled}
                    onCheckedChange={(checked) =>
                      updateServer(index, { enabled: checked })
                    }
                    label={t('Connection enabled')}
                    description={t(
                      'A disabled connection is never called and its tools are not offered.'
                    )}
                  />

                  <SettingsFormGrid>
                    <FormItem>
                      <Label htmlFor={`playground-mcp-server-${index}-id`}>
                        {t('ID')}
                      </Label>
                      <Input
                        aria-invalid={errors[`${prefix}-id`] ? true : undefined}
                        id={`playground-mcp-server-${index}-id`}
                        maxLength={24}
                        onChange={(event) =>
                          updateServer(index, { id: event.target.value })
                        }
                        placeholder='github'
                        spellCheck={false}
                        value={server.id}
                      />
                      <p className='text-muted-foreground text-sm'>
                        {t(
                          'Stable identifier used in tool names. Letters, digits, hyphens and underscores only.'
                        )}
                      </p>
                      {errors[`${prefix}-id`] && (
                        <p className='text-destructive text-sm'>
                          {t(errors[`${prefix}-id`])}
                        </p>
                      )}
                    </FormItem>

                    <FormItem>
                      <Label htmlFor={`playground-mcp-server-${index}-name`}>
                        {t('Name')}
                      </Label>
                      <Input
                        aria-invalid={
                          errors[`${prefix}-name`] ? true : undefined
                        }
                        id={`playground-mcp-server-${index}-name`}
                        maxLength={PLAYGROUND_MCP_MAX_SERVER_NAME_RUNES}
                        onChange={(event) =>
                          updateServer(index, { name: event.target.value })
                        }
                        placeholder={t('GitHub')}
                        value={server.name}
                      />
                      {errors[`${prefix}-name`] && (
                        <p className='text-destructive text-sm'>
                          {t(errors[`${prefix}-name`])}
                        </p>
                      )}
                    </FormItem>

                    <FormItem>
                      <Label htmlFor={`playground-mcp-server-${index}-url`}>
                        {t('Server URL')}
                      </Label>
                      <Input
                        aria-invalid={
                          errors[`${prefix}-url`] ? true : undefined
                        }
                        id={`playground-mcp-server-${index}-url`}
                        maxLength={PLAYGROUND_MCP_MAX_URL_BYTES}
                        onChange={(event) =>
                          updateServer(index, { url: event.target.value })
                        }
                        placeholder='https://mcp.example.com/mcp'
                        spellCheck={false}
                        type='url'
                        value={server.url}
                      />
                      {errors[`${prefix}-url`] && (
                        <p className='text-destructive text-sm'>
                          {t(errors[`${prefix}-url`])}
                        </p>
                      )}
                    </FormItem>

                    <FormItem>
                      <Label htmlFor={`playground-mcp-server-${index}-header`}>
                        {t('Token header')}
                      </Label>
                      <Input
                        aria-invalid={
                          errors[`${prefix}-header`] ? true : undefined
                        }
                        id={`playground-mcp-server-${index}-header`}
                        maxLength={PLAYGROUND_MCP_MAX_HEADER_NAME_BYTES}
                        onChange={(event) =>
                          updateServer(index, { header: event.target.value })
                        }
                        placeholder={PLAYGROUND_MCP_DEFAULT_AUTH_HEADER}
                        spellCheck={false}
                        value={server.header}
                      />
                      <p className='text-muted-foreground text-sm'>
                        {t(
                          'Defaults to Authorization. The gateway reserves its own headers.'
                        )}
                      </p>
                      {errors[`${prefix}-header`] && (
                        <p className='text-destructive text-sm'>
                          {t(errors[`${prefix}-header`])}
                        </p>
                      )}
                    </FormItem>

                    <FormItem>
                      <Label htmlFor={`playground-mcp-server-${index}-token`}>
                        {t('Access token')}
                      </Label>
                      <Input
                        aria-invalid={
                          errors[`${prefix}-token`] ? true : undefined
                        }
                        autoComplete='new-password'
                        id={`playground-mcp-server-${index}-token`}
                        maxLength={PLAYGROUND_MCP_MAX_TOKEN_BYTES}
                        onChange={(event) =>
                          updateServer(index, {
                            token: event.target.value,
                            clearToken: false,
                          })
                        }
                        placeholder={t('Leave blank to keep the stored token')}
                        spellCheck={false}
                        type='password'
                        value={server.token}
                      />
                      <p className='text-muted-foreground text-sm'>
                        {t(tokenHint(server))}
                      </p>
                      {errors[`${prefix}-token`] && (
                        <p className='text-destructive text-sm'>
                          {t(errors[`${prefix}-token`])}
                        </p>
                      )}
                      {server.hasToken || server.clearToken ? (
                        <Button
                          onClick={() =>
                            updateServer(index, {
                              token: '',
                              clearToken: !server.clearToken,
                            })
                          }
                          size='sm'
                          type='button'
                          variant='outline'
                        >
                          {server.clearToken
                            ? t('Keep the stored token')
                            : t('Remove the stored token')}
                        </Button>
                      ) : null}
                    </FormItem>
                  </SettingsFormGrid>

                  <Button
                    aria-label={t('Remove connection')}
                    onClick={() =>
                      setDraft((current) => ({
                        ...current,
                        servers: current.servers.filter(
                          (_, position) => position !== index
                        ),
                      }))
                    }
                    size='sm'
                    type='button'
                    variant='outline'
                  >
                    <Trash2 aria-hidden='true' className='h-4 w-4' />
                    {t('Remove connection')}
                  </Button>
                </div>
              )
            })}

            {draft.servers.length === 0 && (
              <p className='text-muted-foreground text-sm'>
                {t('No MCP connections are configured.')}
              </p>
            )}

            <Button
              disabled={draft.servers.length >= PLAYGROUND_MCP_MAX_SERVERS}
              onClick={handleAdd}
              size='sm'
              type='button'
              variant='outline'
            >
              <Plus aria-hidden='true' className='h-4 w-4' />
              {t('Add connection')}
            </Button>
          </div>
        </div>
      </SettingsForm>
    </SettingsSection>
  )
}
