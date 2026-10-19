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
import { playgroundAttachmentContentUrl } from '@/features/playground/api'
import { loadPlaygroundAttachment } from '@/features/playground/lib/attachment-store'

import {
  CANVAS_NODE_ESTIMATED_HEIGHT,
  CANVAS_NODE_ESTIMATED_WIDTH,
  CANVAS_PNG_EXPORT_MAX_EDGE,
  CANVAS_PNG_EXPORT_MESSAGES,
  CANVAS_PNG_EXPORT_PADDING,
  CANVAS_PNG_EXPORT_SCALE,
  CANVAS_PNG_EXPORT_SCOPES,
} from '../constants'
import type { CanvasFlowNode } from '../types'
import type { CanvasRect } from './canvas-align'
import { canvasAbsolutePosition, canvasDescendantIds } from './canvas-edit'

export type CanvasPngExportScope = (typeof CANVAS_PNG_EXPORT_SCOPES)[number]

export interface CanvasPngExportImageRef {
  sessionId: string
  attachmentId: string
}

export interface CanvasPngExportLayoutNode {
  id: string
  kind: string
  title: string
  body: string
  status?: string
  rect: CanvasRect
  group: boolean
  image?: CanvasPngExportImageRef
}

export interface CanvasPngExportLayout {
  nodes: CanvasPngExportLayoutNode[]
  edges: { id: string; source: CanvasRect; target: CanvasRect }[]
  bounds: CanvasRect
  width: number
  height: number
  scale: number
}

export interface CanvasPngExportOptions {
  /** Rasterization factor before the max-edge clamp. */
  scale?: number
  maxEdge?: number
  padding?: number
  /** `dark` switches the palette for a dark interface. */
  theme?: 'light' | 'dark'
  /** Localized node-kind labels used when a node has no custom label. */
  kindLabels?: Partial<Record<string, string>>
  /** Test seam for environments without a 2D canvas implementation. */
  createCanvas?: () => HTMLCanvasElement
  /** Test seam for image bytes; the default reads the attachment cache. */
  loadImage?: (
    image: CanvasPngExportImageRef
  ) => Promise<CanvasImageSource | null>
}

const EXPORT_COLORS = {
  light: {
    background: '#ffffff',
    card: '#ffffff',
    cardBorder: '#cbd5e1',
    header: '#f1f5f9',
    text: '#0f172a',
    muted: '#64748b',
    edge: '#94a3b8',
    group: '#94a3b8',
    groupFill: 'rgba(148, 163, 184, 0.08)',
  },
  dark: {
    background: '#0b1120',
    card: '#111827',
    cardBorder: '#334155',
    header: '#1f2937',
    text: '#e2e8f0',
    muted: '#94a3b8',
    edge: '#64748b',
    group: '#475569',
    groupFill: 'rgba(148, 163, 184, 0.08)',
  },
} as const

type CanvasExportColors = {
  [K in keyof (typeof EXPORT_COLORS)['light']]: string
}

const NODE_HEADER_HEIGHT = 32
const NODE_PADDING = 12
const MAX_BODY_LINES = 5

export class CanvasPngExportError extends Error {
  constructor(messageKey: string) {
    super(messageKey)
    this.name = 'CanvasPngExportError'
  }
}

function nodeSize(node: CanvasFlowNode): { width: number; height: number } {
  return {
    width: node.measured?.width ?? node.width ?? CANVAS_NODE_ESTIMATED_WIDTH,
    height:
      node.measured?.height ?? node.height ?? CANVAS_NODE_ESTIMATED_HEIGHT,
  }
}

function nodeBody(node: CanvasFlowNode): string {
  return (
    node.data.text?.trim() ||
    node.data.snapshot?.text?.trim() ||
    node.data.workflow?.output?.trim() ||
    node.data.label?.trim() ||
    ''
  )
}

function nodeImage(node: CanvasFlowNode): CanvasPngExportImageRef | null {
  if (node.data.kind !== 'attachment' && node.data.kind !== 'image') return null
  const sessionId = node.data.ref?.sessionId
  const attachmentId = node.data.ref?.attachmentId
  if (!sessionId || !attachmentId) return null
  return { sessionId, attachmentId }
}

/**
 * The node ids a PNG export contains. A selection expands a selected group to
 * its descendants, so a group can never be exported as an empty box; selecting
 * a child without its group exports only that child.
 */
export function canvasPngExportNodeIds(
  nodes: CanvasFlowNode[],
  scope: CanvasPngExportScope
): Set<string> | null {
  if (scope === 'canvas') {
    return new Set(nodes.map((node) => node.id))
  }
  const selected = nodes
    .filter((node) => node.selected === true)
    .map((node) => node.id)
  if (selected.length === 0) return null
  return canvasDescendantIds(nodes, selected)
}

/** Renders the included nodes into a flat layout in canvas coordinates. */
export function canvasPngExportLayout(
  nodes: CanvasFlowNode[],
  edges: { id: string; source: string; target: string }[],
  ids: Set<string>,
  options: CanvasPngExportOptions = {}
): CanvasPngExportLayout | null {
  if (ids.size === 0) return null
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const layoutNodes: CanvasPngExportLayoutNode[] = []
  for (const node of nodes) {
    if (!ids.has(node.id)) continue
    const absolute = canvasAbsolutePosition(node, byId)
    const size = nodeSize(node)
    const image = nodeImage(node)
    layoutNodes.push({
      id: node.id,
      kind: node.data.kind,
      title:
        node.data.label?.trim() ||
        options.kindLabels?.[node.data.kind] ||
        node.data.kind,
      body: nodeBody(node),
      ...(node.data.workflow?.status
        ? { status: node.data.workflow.status }
        : {}),
      rect: {
        x: absolute.x,
        y: absolute.y,
        width: size.width,
        height: size.height,
      },
      group: node.data.kind === 'group',
      ...(image ? { image } : {}),
    })
  }
  if (layoutNodes.length === 0) return null
  let left = Number.POSITIVE_INFINITY
  let top = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  for (const entry of layoutNodes) {
    left = Math.min(left, entry.rect.x)
    top = Math.min(top, entry.rect.y)
    right = Math.max(right, entry.rect.x + entry.rect.width)
    bottom = Math.max(bottom, entry.rect.y + entry.rect.height)
  }
  const padding = options.padding ?? CANVAS_PNG_EXPORT_PADDING
  const bounds: CanvasRect = {
    x: left - padding,
    y: top - padding,
    width: right - left + padding * 2,
    height: bottom - top + padding * 2,
  }
  const maxEdge = Math.max(1, options.maxEdge ?? CANVAS_PNG_EXPORT_MAX_EDGE)
  const wantedScale = options.scale ?? CANVAS_PNG_EXPORT_SCALE
  const scale = Math.min(
    wantedScale,
    maxEdge / Math.max(bounds.width, 1),
    maxEdge / Math.max(bounds.height, 1)
  )
  const rectById = new Map(layoutNodes.map((entry) => [entry.id, entry.rect]))
  const layoutEdges = edges
    .filter(
      (edge) =>
        ids.has(edge.source) &&
        ids.has(edge.target) &&
        !rectById.get(edge.source)?.group &&
        !rectById.get(edge.target)?.group
    )
    .map((edge) => ({
      id: edge.id,
      source: rectById.get(edge.source) as CanvasRect,
      target: rectById.get(edge.target) as CanvasRect,
    }))
  return {
    nodes: layoutNodes,
    edges: layoutEdges,
    bounds,
    width: Math.max(
      1,
      Math.min(Math.ceil(maxEdge), Math.ceil(bounds.width * scale))
    ),
    height: Math.max(
      1,
      Math.min(Math.ceil(maxEdge), Math.ceil(bounds.height * scale))
    ),
    scale,
  }
}

/** The suffix-free filename stem of a canvas PNG export. */
export function canvasPngExportFilename(
  title: string,
  scope: CanvasPngExportScope
): string {
  const stem =
    title
      .trim()
      .replace(/[\\/:*?"<>|]+/g, '-')
      .replace(/\s+/g, ' ')
      .slice(0, 60) || 'canvas'
  return scope === 'selection' ? `${stem}-selection.png` : `${stem}.png`
}

/**
 * Wraps text to the given width, clipping to `maxLines` with an ellipsis. The
 * context only needs `measureText`, so the helper is usable with a fake canvas
 * context in tests.
 */
export function wrapCanvasExportText(
  ctx: Pick<CanvasRenderingContext2D, 'measureText'>,
  text: string,
  maxWidth: number,
  maxLines: number
): string[] {
  const lines: string[] = []
  for (const rawLine of text.split('\n')) {
    let current = ''
    for (const word of rawLine.split(/\s+/)) {
      if (word.length === 0) continue
      if (ctx.measureText(word).width > maxWidth) {
        // Languages without spaces (and very long URLs) have no word boundary
        // to break at, so fill a line character by character instead of
        // squeezing the whole run into one `fillText` call. Flush a preceding
        // word first so the long run starts at a line boundary.
        if (current) {
          lines.push(current)
          current = ''
          if (lines.length >= maxLines) break
        }
        for (const character of word) {
          const next = current + character
          if (current && ctx.measureText(next).width > maxWidth) {
            lines.push(current)
            current = character
            if (lines.length >= maxLines) break
          } else {
            current = next
          }
        }
        if (lines.length >= maxLines) break
        continue
      }
      const candidate = current ? `${current} ${word}` : word
      if (ctx.measureText(candidate).width <= maxWidth || !current) {
        current = candidate
        continue
      }
      lines.push(current)
      current = word
      if (lines.length >= maxLines) break
    }
    if (lines.length >= maxLines) break
    if (current) lines.push(current)
    if (lines.length >= maxLines) break
  }
  if (lines.length > maxLines) lines.length = maxLines
  if (lines.length === maxLines) {
    const consumed = lines.join(' ')
    if (consumed.length < text.replace(/\s+/g, ' ').trim().length) {
      let last = lines[maxLines - 1]
      while (last.length > 1 && ctx.measureText(`${last}…`).width > maxWidth) {
        last = last.slice(0, -1)
      }
      lines[maxLines - 1] = `${last}…`
    }
  }
  return lines.length > 0 ? lines : ['']
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  rect: CanvasRect,
  radius: number
) {
  const r = Math.min(radius, rect.width / 2, rect.height / 2)
  ctx.beginPath()
  ctx.moveTo(rect.x + r, rect.y)
  ctx.lineTo(rect.x + rect.width - r, rect.y)
  ctx.arcTo(rect.x + rect.width, rect.y, rect.x + rect.width, rect.y + r, r)
  ctx.lineTo(rect.x + rect.width, rect.y + rect.height - r)
  ctx.arcTo(
    rect.x + rect.width,
    rect.y + rect.height,
    rect.x + rect.width - r,
    rect.y + rect.height,
    r
  )
  ctx.lineTo(rect.x + r, rect.y + rect.height)
  ctx.arcTo(rect.x, rect.y + rect.height, rect.x, rect.y + rect.height - r, r)
  ctx.lineTo(rect.x, rect.y + r)
  ctx.arcTo(rect.x, rect.y, rect.x + r, rect.y, r)
  ctx.closePath()
}

function drawEdge(
  ctx: CanvasRenderingContext2D,
  from: CanvasRect,
  to: CanvasRect,
  color: string
) {
  const startX = from.x + from.width
  const startY = from.y + from.height / 2
  const endX = to.x
  const endY = to.y + to.height / 2
  const curve = Math.max(40, Math.abs(endX - startX) * 0.5)
  ctx.strokeStyle = color
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(startX, startY)
  ctx.bezierCurveTo(startX + curve, startY, endX - curve, endY, endX, endY)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(endX, endY)
  ctx.lineTo(endX - 8, endY - 4)
  ctx.lineTo(endX - 8, endY + 4)
  ctx.closePath()
  ctx.fillStyle = color
  ctx.fill()
}

function drawNode(
  ctx: CanvasRenderingContext2D,
  entry: CanvasPngExportLayoutNode,
  colors: CanvasExportColors,
  image: CanvasImageSource | null
) {
  if (entry.group) {
    ctx.setLineDash([6, 4])
    roundedRect(ctx, entry.rect, 8)
    ctx.fillStyle = colors.groupFill
    ctx.fill()
    ctx.strokeStyle = colors.group
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = colors.muted
    ctx.font = '12px sans-serif'
    ctx.textBaseline = 'top'
    ctx.fillText(
      entry.title,
      entry.rect.x + NODE_PADDING,
      entry.rect.y + NODE_PADDING / 2,
      entry.rect.width - NODE_PADDING * 2
    )
    return
  }
  roundedRect(ctx, entry.rect, 8)
  ctx.fillStyle = colors.card
  ctx.fill()
  ctx.strokeStyle = colors.cardBorder
  ctx.lineWidth = 1
  ctx.stroke()
  const header: CanvasRect = {
    x: entry.rect.x,
    y: entry.rect.y,
    width: entry.rect.width,
    height: Math.min(NODE_HEADER_HEIGHT, entry.rect.height),
  }
  roundedRect(ctx, header, 8)
  ctx.fillStyle = colors.header
  ctx.fill()
  ctx.fillStyle = colors.text
  ctx.font = '600 12px sans-serif'
  ctx.textBaseline = 'middle'
  ctx.fillText(
    entry.title,
    header.x + NODE_PADDING,
    header.y + header.height / 2,
    header.width - NODE_PADDING * 2
  )
  if (entry.status) {
    ctx.beginPath()
    ctx.arc(
      header.x + header.width - NODE_PADDING,
      header.y + header.height / 2,
      4,
      0,
      Math.PI * 2
    )
    let statusColor = '#f59e0b'
    if (entry.status === 'failed') {
      statusColor = '#ef4444'
    } else if (entry.status === 'succeeded') {
      statusColor = '#22c55e'
    }
    ctx.fillStyle = statusColor
    ctx.fill()
  }
  const bodyTop = entry.rect.y + header.height
  const bodyWidth = entry.rect.width - NODE_PADDING * 2
  if (image) {
    const imageHeight = Math.max(
      0,
      Math.min(entry.rect.height - header.height - NODE_PADDING, 180)
    )
    const imageWidth = entry.rect.width - NODE_PADDING * 2
    if (imageHeight > 0 && imageWidth > 0) {
      ctx.drawImage(
        image,
        entry.rect.x + NODE_PADDING,
        bodyTop + NODE_PADDING / 2,
        imageWidth,
        imageHeight
      )
    }
    return
  }
  if (!entry.body || bodyWidth <= 0) return
  ctx.fillStyle = colors.muted
  ctx.font = '12px sans-serif'
  ctx.textBaseline = 'top'
  const lines = wrapCanvasExportText(ctx, entry.body, bodyWidth, MAX_BODY_LINES)
  lines.forEach((line, index) => {
    ctx.fillText(
      line,
      entry.rect.x + NODE_PADDING,
      bodyTop + NODE_PADDING + index * 16,
      bodyWidth
    )
  })
}

/** Paints a layout into a 2D context; exported for focused render tests. */
export function paintCanvasPngExport(
  ctx: CanvasRenderingContext2D,
  layout: CanvasPngExportLayout,
  images: Map<string, CanvasImageSource | null>,
  theme: 'light' | 'dark' = 'light'
) {
  const colors = EXPORT_COLORS[theme]
  ctx.save()
  ctx.scale(layout.scale, layout.scale)
  ctx.translate(-layout.bounds.x, -layout.bounds.y)
  ctx.fillStyle = colors.background
  ctx.fillRect(
    layout.bounds.x,
    layout.bounds.y,
    layout.bounds.width,
    layout.bounds.height
  )
  for (const edge of layout.edges) {
    drawEdge(ctx, edge.source, edge.target, colors.edge)
  }
  for (const entry of layout.nodes) {
    if (entry.group) drawNode(ctx, entry, colors, null)
  }
  for (const entry of layout.nodes) {
    if (entry.group) continue
    drawNode(ctx, entry, colors, images.get(entry.id) ?? null)
  }
  ctx.restore()
}

async function loadCanvasPngImage(
  image: CanvasPngExportImageRef
): Promise<CanvasImageSource | null> {
  try {
    const entry = await loadPlaygroundAttachment(
      playgroundAttachmentContentUrl(image.sessionId, image.attachmentId),
      image.attachmentId
    )
    const source = entry.dataUrl ?? entry.objectUrl
    if (!source) return null
    const element = new Image()
    element.src = source
    if (typeof element.decode === 'function') {
      await element.decode()
    } else {
      await new Promise<void>((resolve, reject) => {
        element.addEventListener('load', () => resolve(), { once: true })
        element.addEventListener(
          'error',
          () => reject(new Error('Image load failed')),
          { once: true }
        )
      })
    }
    return element
  } catch {
    return null
  }
}

export interface CanvasPngExportResult {
  blob: Blob
  width: number
  height: number
  scope: CanvasPngExportScope
  filename: string
}

/**
 * Renders the chosen nodes into a PNG blob. The renderer is browser-local: it
 * only reads nodes and edges, never uploads or mutates the board, and image
 * bytes come from the owner-scoped attachment cache.
 */
export async function renderCanvasPng(
  nodes: CanvasFlowNode[],
  edges: { id: string; source: string; target: string }[],
  scope: CanvasPngExportScope,
  title: string,
  options: CanvasPngExportOptions = {}
): Promise<CanvasPngExportResult> {
  const ids = canvasPngExportNodeIds(nodes, scope)
  if (!ids || ids.size === 0) {
    throw new CanvasPngExportError(
      scope === 'selection'
        ? CANVAS_PNG_EXPORT_MESSAGES.EMPTY_SELECTION
        : CANVAS_PNG_EXPORT_MESSAGES.EMPTY
    )
  }
  const layout = canvasPngExportLayout(nodes, edges, ids, options)
  if (!layout) {
    throw new CanvasPngExportError(CANVAS_PNG_EXPORT_MESSAGES.EMPTY)
  }
  const createCanvas =
    options.createCanvas ?? (() => document.createElement('canvas'))
  const canvas = createCanvas()
  canvas.width = layout.width
  canvas.height = layout.height
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    throw new CanvasPngExportError(CANVAS_PNG_EXPORT_MESSAGES.FAILED)
  }
  const loadImage = options.loadImage ?? loadCanvasPngImage
  const images = new Map<string, CanvasImageSource | null>()
  await Promise.all(
    layout.nodes
      .filter((entry) => entry.image)
      .map(async (entry) => {
        images.set(
          entry.id,
          await loadImage(entry.image as CanvasPngExportImageRef)
        )
      })
  )
  paintCanvasPngExport(ctx, layout, images, options.theme ?? 'light')
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/png')
  )
  if (!blob) {
    throw new CanvasPngExportError(CANVAS_PNG_EXPORT_MESSAGES.FAILED)
  }
  return {
    blob,
    width: layout.width,
    height: layout.height,
    scope,
    filename: canvasPngExportFilename(title, scope),
  }
}
