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
import { PlaygroundMCPSection } from '../playground/playground-mcp-section'
import { PlaygroundModelCatalogSection } from '../playground/playground-model-catalog-section'
import { PlaygroundQuotaSection } from '../playground/playground-quota-section'
import { PlaygroundStorageBillingSection } from '../playground/playground-storage-billing-section'
import { PlaygroundWebSearchSection } from '../playground/playground-web-search-section'
import { RateLimitSection } from '../request-limits/rate-limit-section'
import { SSRFSection } from '../request-limits/ssrf-section'
import { TokenLimitSection } from '../request-limits/token-limit-section'
import type { SecuritySettings } from '../types'
import { createSectionRegistry } from '../utils/section-registry'

const SECURITY_SECTIONS = [
  {
    id: 'rate-limit',
    titleKey: 'Rate Limiting',
    build: (settings: SecuritySettings) => (
      <RateLimitSection
        defaultValues={{
          ModelRequestRateLimitEnabled: settings.ModelRequestRateLimitEnabled,
          ModelRequestRateLimitCount: settings.ModelRequestRateLimitCount,
          ModelRequestRateLimitSuccessCount:
            settings.ModelRequestRateLimitSuccessCount,
          ModelRequestRateLimitDurationMinutes:
            settings.ModelRequestRateLimitDurationMinutes,
          ModelRequestRateLimitGroup: settings.ModelRequestRateLimitGroup,
        }}
      />
    ),
  },

  {
    id: 'ssrf',
    titleKey: 'SSRF Protection',
    build: (settings: SecuritySettings) => (
      <SSRFSection
        defaultValues={{
          'fetch_setting.enable_ssrf_protection':
            settings['fetch_setting.enable_ssrf_protection'],
          'fetch_setting.allow_private_ip':
            settings['fetch_setting.allow_private_ip'],
          'fetch_setting.domain_filter_mode':
            settings['fetch_setting.domain_filter_mode'],
          'fetch_setting.ip_filter_mode':
            settings['fetch_setting.ip_filter_mode'],
          'fetch_setting.domain_list': settings['fetch_setting.domain_list'],
          'fetch_setting.ip_list': settings['fetch_setting.ip_list'],
          'fetch_setting.allowed_ports':
            settings['fetch_setting.allowed_ports'],
          'fetch_setting.apply_ip_filter_for_domain':
            settings['fetch_setting.apply_ip_filter_for_domain'],
        }}
      />
    ),
  },
  {
    id: 'token-limits',
    titleKey: 'Token Limits',
    build: (settings: SecuritySettings) => (
      <TokenLimitSection
        defaultValues={{
          'token_setting.max_user_tokens':
            settings['token_setting.max_user_tokens'],
        }}
      />
    ),
  },
  {
    id: 'playground-quotas',
    titleKey: 'Playground Resource Quotas',
    build: (settings: SecuritySettings) => (
      <PlaygroundQuotaSection
        defaultsJson={settings['playground_setting.defaults']}
        groupOverridesJson={settings['playground_setting.group_overrides']}
        sandboxPreviewEnabled={
          settings['playground_setting.sandbox_preview_enabled']
        }
      />
    ),
  },
  {
    id: 'playground-model-catalog',
    titleKey: 'Playground Model Catalog',
    build: (settings: SecuritySettings) => (
      <PlaygroundModelCatalogSection
        catalogJson={settings['playground_setting.model_catalog']}
      />
    ),
  },
  {
    id: 'playground-storage-billing',
    titleKey: 'Playground Storage Billing',
    build: (settings: SecuritySettings) => (
      <PlaygroundStorageBillingSection
        storageBillingJson={settings['playground_setting.storage_billing']}
      />
    ),
  },
  {
    id: 'playground-web-search',
    titleKey: 'Playground Web Search',
    build: (settings: SecuritySettings) => (
      <PlaygroundWebSearchSection
        webSearchJson={settings['playground_setting.web_search']}
      />
    ),
  },
  {
    id: 'playground-mcp',
    titleKey: 'Playground MCP Tools',
    build: (settings: SecuritySettings) => (
      <PlaygroundMCPSection mcpJson={settings['playground_setting.mcp']} />
    ),
  },
] as const

export type SecuritySectionId = (typeof SECURITY_SECTIONS)[number]['id']

const securityRegistry = createSectionRegistry<
  SecuritySectionId,
  SecuritySettings
>({
  sections: SECURITY_SECTIONS,
  defaultSection: 'rate-limit',
  basePath: '/system-settings/security',
  urlStyle: 'path',
})

export const SECURITY_SECTION_IDS = securityRegistry.sectionIds
export const SECURITY_DEFAULT_SECTION = securityRegistry.defaultSection
export const getSecuritySectionNavItems = securityRegistry.getSectionNavItems
export const getSecuritySectionContent = securityRegistry.getSectionContent
export const getSecuritySectionMeta = securityRegistry.getSectionMeta
