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
import type { StatusVariant } from '@/components/status-badge'

import type { PlaygroundComparisonRunStatus } from '../../types'

/** Display labels and badge tones of a stored compare run's lifecycle. */
export const COMPARISON_RUN_STATUS_LABELS: Record<
  PlaygroundComparisonRunStatus,
  string
> = {
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  canceled: 'Canceled',
}

export const COMPARISON_RUN_STATUS_VARIANTS: Record<
  PlaygroundComparisonRunStatus,
  StatusVariant
> = {
  running: 'info',
  completed: 'success',
  failed: 'danger',
  canceled: 'warning',
}
