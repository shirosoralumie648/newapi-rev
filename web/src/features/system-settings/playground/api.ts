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
import { api } from '@/lib/api'
import { requireServerSuccess } from '@/lib/server-error-message'

// Admin data access for the optional metered storage tier. Every function is
// read-only: listing and exporting the daily ledger, and comparing it with the
// unified wallet ledger. Reconciliation never moves money.

/** One account's storage billing day, as the server recorded it. */
export interface PlaygroundStorageLedgerDay {
  id: number
  user_id: number
  date: string
  peak_bytes: number
  free_bytes: number
  billable_bytes: number
  egress_bytes: number
  egress_requests: number
  quota: number
  debt_quota: number
  egress_quota: number
  status: string
  grace_until: number
  settled_at: number
  created_at: number
  updated_at: number
}

export interface PlaygroundStorageLedgerPage {
  items: PlaygroundStorageLedgerDay[]
  total: number
}

export interface PlaygroundStorageLedgerFilters {
  /** Restricts the view to one account; omitted lists every account. */
  userId?: number
  /** Inclusive YYYY-MM-DD bounds; omitted leaves the side unbounded. */
  start?: string
  end?: string
}

export interface PlaygroundStorageReconciliation {
  user_id: number
  storage_quota: number
  wallet_quota: number
  day_count: number
  deviation: number
  reconciled: boolean
  checked_at: number
}

export interface PlaygroundStorageReconciliationReport {
  checked_at: number
  user_count: number
  deviation_count: number
  deviations: PlaygroundStorageReconciliation[]
}

const PLAYGROUND_STORAGE_LEDGER_PATH = '/api/user/playground/storage/ledger'
const PLAYGROUND_STORAGE_RECONCILE_PATH =
  '/api/user/playground/storage/reconcile'

function storageLedgerQuery(filters: PlaygroundStorageLedgerFilters): string {
  const params = new URLSearchParams()
  if (filters.userId) params.set('user_id', String(filters.userId))
  if (filters.start) params.set('start', filters.start)
  if (filters.end) params.set('end', filters.end)
  const query = params.toString()
  return query ? `?${query}` : ''
}

/**
 * One page of the daily storage ledger, newest first. The server caps the page
 * size, so the caller passes its own paging state.
 */
export async function getPlaygroundStorageLedger(
  filters: PlaygroundStorageLedgerFilters,
  page: number,
  pageSize: number
): Promise<PlaygroundStorageLedgerPage> {
  const params = new URLSearchParams(storageLedgerQuery(filters).slice(1))
  params.set('p', page.toString())
  params.set('page_size', pageSize.toString())
  const response = await api.get(
    `${PLAYGROUND_STORAGE_LEDGER_PATH}?${params.toString()}`
  )
  requireServerSuccess(response.data)
  const data = response.data?.data as
    | { items?: PlaygroundStorageLedgerDay[]; total?: number }
    | undefined
  return { items: data?.items ?? [], total: data?.total ?? 0 }
}

/**
 * Fetch the selected ledger days as a CSV blob; the caller decides when to
 * save it. The same filters as the list view apply.
 */
export async function exportPlaygroundStorageLedgerCsv(
  filters: PlaygroundStorageLedgerFilters
): Promise<Blob> {
  const response = await api.get(
    `${PLAYGROUND_STORAGE_LEDGER_PATH}/export${storageLedgerQuery(filters)}`,
    { responseType: 'blob' }
  )
  return response.data as Blob
}

/**
 * Compare the settled storage days with the matching wallet-ledger rows. The
 * report lists the first deviating accounts; the call changes nothing.
 */
export async function reconcilePlaygroundStorageBilling(
  userId?: number
): Promise<PlaygroundStorageReconciliationReport> {
  const response = await api.get(
    `${PLAYGROUND_STORAGE_RECONCILE_PATH}${storageLedgerQuery({ userId })}`
  )
  requireServerSuccess(response.data)
  return (
    (response.data?.data as
      | PlaygroundStorageReconciliationReport
      | undefined) ?? {
      checked_at: 0,
      user_count: 0,
      deviation_count: 0,
      deviations: [],
    }
  )
}
