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
export type PlaygroundWebSearchProvider = 'tavily' | 'searxng' | 'brave'

export type PlaygroundWebSearchDraft = {
  enabled: boolean
  provider: PlaygroundWebSearchProvider
  baseURL: string
  priceUSDPerCall: string
}

export type PlaygroundWebSearchGroupPriceDraft = {
  group: string
  priceUSDPerCall: string
}

export const PLAYGROUND_WEB_SEARCH_PROVIDERS: readonly PlaygroundWebSearchProvider[] =
  ['tavily', 'searxng', 'brave']

// Mirrors setting/playground_setting, so the section shows the values the
// gateway uses before an administrator saves it for the first time.
export const PLAYGROUND_WEB_SEARCH_DEFAULTS: PlaygroundWebSearchDraft = {
  enabled: false,
  provider: 'tavily',
  baseURL: '',
  priceUSDPerCall: '0',
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readNumber(value: unknown, fallback: number): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? String(value)
    : String(fallback)
}

function normalizeProvider(value: unknown): PlaygroundWebSearchProvider | null {
  if (typeof value !== 'string') return null
  const provider = value.trim().toLowerCase()
  return (
    PLAYGROUND_WEB_SEARCH_PROVIDERS.find(
      (candidate) => candidate === provider
    ) ?? null
  )
}

export function parsePlaygroundWebSearch(json: string): {
  draft: PlaygroundWebSearchDraft
  groupPrices: PlaygroundWebSearchGroupPriceDraft[]
} {
  let parsed: Record<string, unknown> = {}
  try {
    const value: unknown = JSON.parse(json || '{}')
    if (isRecord(value)) parsed = value
  } catch {
    parsed = {}
  }
  const groupPrices: PlaygroundWebSearchGroupPriceDraft[] = []
  if (isRecord(parsed.group_price_usd_per_call)) {
    for (const [group, value] of Object.entries(
      parsed.group_price_usd_per_call
    )) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        groupPrices.push({ group, priceUSDPerCall: String(value) })
      }
    }
    groupPrices.sort((a, b) => a.group.localeCompare(b.group))
  }
  return {
    draft: {
      enabled: parsed.enabled === true,
      provider:
        normalizeProvider(parsed.provider) ??
        PLAYGROUND_WEB_SEARCH_DEFAULTS.provider,
      baseURL:
        typeof parsed.base_url === 'string' ? parsed.base_url.trim() : '',
      priceUSDPerCall: readNumber(
        parsed.price_usd_per_call,
        Number(PLAYGROUND_WEB_SEARCH_DEFAULTS.priceUSDPerCall)
      ),
    },
    groupPrices,
  }
}

export function serializePlaygroundWebSearch(
  draft: PlaygroundWebSearchDraft,
  groupPrices: PlaygroundWebSearchGroupPriceDraft[]
): string {
  const entries = [...groupPrices]
    .sort((a, b) => a.group.localeCompare(b.group))
    .map((entry) => [entry.group, Number(entry.priceUSDPerCall)] as const)
  return JSON.stringify({
    enabled: draft.enabled,
    provider: draft.provider,
    base_url: draft.baseURL.trim(),
    price_usd_per_call: Number(draft.priceUSDPerCall),
    group_price_usd_per_call: Object.fromEntries(entries),
  })
}

export function isNonNegativeNumber(value: string): boolean {
  if (value.trim() === '') return false
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0
}
