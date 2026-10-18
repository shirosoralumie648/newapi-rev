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
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Share2,
  ShieldCheck,
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@/components/empty-state'
import { SectionPageLayout } from '@/components/layout'
import { LoadingState } from '@/components/loading-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { IconBadge } from '@/components/ui/icon-badge'
import { formatPercent, formatQuota } from '@/lib/format'
import { ROLE } from '@/lib/roles'
import { useAuthStore } from '@/stores/auth-store'

import { ReferralAgentTiersCard } from './components/referral-agent-tiers-card'
import { ReferralAgentsCard } from './components/referral-agents-card'
import { ReferralInvitationTable } from './components/referral-invitation-table'
import { useSelfReferralAgent, useSelfReferralInvitations } from './hooks'
import {
  EMPTY_REFERRAL_AGENT_PROFILE,
  getReferralRateSourceLabelKey,
} from './lib'

const REFERRAL_PROGRAM_PAGE_SIZE = 20

/**
 * The dedicated referral program page: the caller's agent profile (mark, tier,
 * effective commission rate with its source), the single-level invitation list
 * and, for administrators, the tier catalogue and the agent mark management.
 */
export function ReferralProgram() {
  const { t } = useTranslation()
  const role = useAuthStore((state) => state.auth.user?.role ?? 0)
  const [page, setPage] = useState(1)
  const profileQuery = useSelfReferralAgent()
  const invitationsQuery = useSelfReferralInvitations(
    page,
    REFERRAL_PROGRAM_PAGE_SIZE,
    true
  )

  const profile = profileQuery.data ?? EMPTY_REFERRAL_AGENT_PROFILE
  const summary = profile.summary
  const invitations = invitationsQuery.data?.items ?? []
  const total = invitationsQuery.data?.total ?? 0
  const windowMonths = invitationsQuery.data?.window_months ?? 0
  const totalPages = Math.max(1, Math.ceil(total / REFERRAL_PROGRAM_PAGE_SIZE))
  const isAdmin = role >= ROLE.ADMIN

  return (
    <SectionPageLayout>
      <SectionPageLayout.Title>{t('Referral Program')}</SectionPageLayout.Title>
      <SectionPageLayout.Content>
        <div className='mx-auto flex w-full max-w-7xl flex-col gap-4 sm:gap-5'>
          <div className='rounded-lg border'>
            <div className='flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3 sm:px-5'>
              <div className='flex items-center gap-2.5'>
                <IconBadge tone='chart-3' size='stat'>
                  <Share2 aria-hidden='true' />
                </IconBadge>
                <div>
                  <div className='text-sm font-medium'>{t('Agent status')}</div>
                  <p className='text-muted-foreground text-xs'>
                    {t(
                      'Your referral agent tier and the commission rate applied to your invitations.'
                    )}
                  </p>
                </div>
              </div>
              <Badge variant={profile.marked ? 'default' : 'secondary'}>
                {profile.marked
                  ? t('Referral agent')
                  : t('Not a referral agent')}
              </Badge>
            </div>
            <div className='flex flex-col gap-3 px-4 py-3 sm:px-5'>
              {profileQuery.isLoading ? (
                <LoadingState className='min-h-[140px]' />
              ) : profileQuery.isError ? (
                <EmptyState
                  icon={AlertTriangle}
                  title={t('Failed to load the referral agent profile')}
                  description={t('Something went wrong!')}
                  className='min-h-[140px]'
                />
              ) : (
                <>
                  <div className='grid grid-cols-2 gap-2 sm:grid-cols-3'>
                    {[
                      [
                        t('Commission rate'),
                        formatPercent(profile.rate_percent),
                      ],
                      [
                        t('Rate source'),
                        t(getReferralRateSourceLabelKey(profile.rate_source)),
                      ],
                      [
                        t('Tier'),
                        profile.marked
                          ? profile.tier_name || profile.tier_id || t('None')
                          : t('None'),
                      ],
                    ].map(([label, value]) => (
                      <div
                        key={label}
                        className='bg-muted/40 rounded-lg px-3 py-2'
                      >
                        <div className='text-muted-foreground truncate text-xs'>
                          {label}
                        </div>
                        <div className='mt-0.5 truncate text-sm font-semibold'>
                          {value}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className='grid grid-cols-2 gap-2 sm:grid-cols-4'>
                    {[
                      [t('Invitees'), String(summary.total_invitees)],
                      [
                        t('Invitees with commissions'),
                        String(summary.invitees_with_commission),
                      ],
                      [t('Total Paid'), formatQuota(summary.total_paid_quota)],
                      [
                        t('Total Commission'),
                        formatQuota(summary.total_commission_quota),
                      ],
                    ].map(([label, value]) => (
                      <div
                        key={label}
                        className='bg-muted/40 rounded-lg px-3 py-2'
                      >
                        <div className='text-muted-foreground truncate text-xs'>
                          {label}
                        </div>
                        <div className='mt-0.5 truncate font-mono text-sm font-semibold tabular-nums'>
                          {value}
                        </div>
                      </div>
                    ))}
                  </div>
                  <p className='text-muted-foreground text-xs'>
                    {`${t('Pending')} ${formatQuota(summary.pending_quota)} · ${t('Locked')} ${formatQuota(summary.locked_quota)} · ${t('Settled')} ${formatQuota(summary.settled_quota)} · ${t('Refunded')} ${formatQuota(summary.refunded_quota)}`}
                  </p>
                  {!profile.enabled ? (
                    <p className='text-muted-foreground text-xs'>
                      {t(
                        'Referral commission is disabled; recorded amounts remain listed.'
                      )}
                    </p>
                  ) : null}
                </>
              )}
            </div>
          </div>

          <div className='rounded-lg border'>
            <div className='flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3 sm:px-5'>
              <div className='flex items-center gap-2.5'>
                <IconBadge tone='chart-2' size='stat'>
                  <Share2 aria-hidden='true' />
                </IconBadge>
                <div>
                  <div className='text-sm font-medium'>
                    {t('Referral Invitations')}
                  </div>
                  <p className='text-muted-foreground text-xs'>
                    {t(
                      'Accounts that joined through your invitation, with partially masked account names'
                    )}
                  </p>
                </div>
              </div>
              <div className='flex items-center gap-2'>
                <Button
                  variant='outline'
                  size='sm'
                  aria-label={t('Go to previous page')}
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                  disabled={page <= 1}
                  className='h-8 w-8 p-0'
                >
                  <ChevronLeft className='h-4 w-4' />
                </Button>
                <span
                  className='text-muted-foreground text-sm tabular-nums'
                  aria-live='polite'
                >
                  {page} / {totalPages}
                </span>
                <Button
                  variant='outline'
                  size='sm'
                  aria-label={t('Go to next page')}
                  onClick={() => setPage((current) => current + 1)}
                  disabled={page >= totalPages}
                  className='h-8 w-8 p-0'
                >
                  <ChevronRight className='h-4 w-4' />
                </Button>
              </div>
            </div>
            <div className='px-4 py-3 sm:px-5'>
              <ReferralInvitationTable
                invitations={invitations}
                windowMonths={windowMonths}
                isLoading={invitationsQuery.isLoading}
                isError={invitationsQuery.isError}
              />
            </div>
          </div>

          {isAdmin ? (
            <>
              <div className='flex items-center gap-2 pt-1'>
                <ShieldCheck aria-hidden='true' className='size-4' />
                <span className='text-sm font-medium'>
                  {t('Administration')}
                </span>
              </div>
              <ReferralAgentTiersCard />
              <ReferralAgentsCard />
            </>
          ) : null}
        </div>
      </SectionPageLayout.Content>
    </SectionPageLayout>
  )
}
