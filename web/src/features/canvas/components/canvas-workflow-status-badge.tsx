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
import { useTranslation } from 'react-i18next'

import { Badge } from '@/components/ui/badge'

import { CANVAS_WORKFLOW_STATUS_LABELS } from '../lib/canvas-workflow'
import type { CanvasWorkflowNodeStatus } from '../types'

const STATUS_VARIANTS: Record<
  CanvasWorkflowNodeStatus,
  'outline' | 'secondary' | 'default' | 'destructive' | 'warning'
> = {
  idle: 'outline',
  running: 'secondary',
  succeeded: 'default',
  failed: 'destructive',
  canceled: 'warning',
}

/** The run state of one workflow step, shown identically on card and detail. */
export function CanvasWorkflowStatusBadge(props: {
  status: CanvasWorkflowNodeStatus
}) {
  const { t } = useTranslation()

  return (
    <Badge variant={STATUS_VARIANTS[props.status]}>
      {t(CANVAS_WORKFLOW_STATUS_LABELS[props.status])}
    </Badge>
  )
}
