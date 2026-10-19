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
  Crop,
  Eraser,
  Expand,
  Maximize2,
  Paintbrush,
  Palette,
  type LucideIcon,
} from 'lucide-react'

import type { CanvasImageToolKind } from '../../lib/canvas-image-tools'

// One icon per image tool; the buttons map over the title record so a new tool
// needs its entry here and in the titles. Shared by the node inspector and the
// image workbench toolbar so the same tool keeps one icon everywhere.
export const CANVAS_IMAGE_TOOL_ICONS: Record<CanvasImageToolKind, LucideIcon> =
  {
    crop: Crop,
    redraw: Paintbrush,
    upscale: Maximize2,
    outpaint: Expand,
    backgroundRemoval: Eraser,
    styleReference: Palette,
  }
