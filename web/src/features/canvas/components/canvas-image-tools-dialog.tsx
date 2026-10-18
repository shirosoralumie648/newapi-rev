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
import { Loader2 } from 'lucide-react'
import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'

import { Dialog } from '@/components/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Textarea } from '@/components/ui/textarea'
import { PLAYGROUND_IMAGE_SIZES } from '@/features/playground/constants'
import type { ModelOption } from '@/features/playground/types'

import {
  CANVAS_IMAGE_TOOL_BRUSH_SIZES,
  CANVAS_IMAGE_TOOL_MESSAGES,
  CANVAS_IMAGE_TOOL_TITLES,
  CANVAS_WORKFLOW_IMAGE_SIZE_RATIOS,
} from '../constants'
import {
  availableCanvasImageUpscaleFactors,
  canvasImageCropRect,
  canvasImageCropRectFromDisplay,
  canvasImageRedrawError,
  canvasImageScale,
  clampCanvasImageCropRect,
  isCanvasImageCropUsable,
  type CanvasImageCropRect,
  type CanvasImageMaskStroke,
  type CanvasImagePoint,
  type CanvasImageRedrawInput,
  type CanvasImageSize,
  type CanvasImageToolKind,
} from '../lib/canvas-image-tools'

export interface CanvasImageToolsDialogProps {
  /** The open tool, or null when the dialog is closed. */
  tool: CanvasImageToolKind | null
  /** Data URL of the selected image; null while it is still being read. */
  source: string | null
  sourceSize: CanvasImageSize | null
  /** A transform or request of the hook is in flight. */
  busy: boolean
  disabled?: boolean
  models: ModelOption[]
  onClose: () => void
  onCrop: (rect: CanvasImageCropRect) => Promise<boolean>
  onRedraw: (input: CanvasImageRedrawInput) => Promise<boolean>
  onUpscale: (factor: number) => Promise<boolean>
}

/**
 * One image tool dialog: crop draws and types a rectangle, redraw paints a mask
 * and describes the change, upscale picks a factor. Every dialog works on the
 * bytes the hook read from the selected node and reports its result by adding a
 * new linked node; the relay request of a redraw is the ordinary
 * /pg/images/edits route.
 */
export function CanvasImageToolsDialog(props: CanvasImageToolsDialogProps) {
  const { t } = useTranslation()
  const [cropRect, setCropRect] = useState<CanvasImageCropRect | null>(null)
  const [strokes, setStrokes] = useState<CanvasImageMaskStroke[]>([])
  const [draft, setDraft] = useState<CanvasImageMaskStroke | null>(null)
  const [brushSize, setBrushSize] = useState<number>(
    CANVAS_IMAGE_TOOL_BRUSH_SIZES[1]
  )
  const [prompt, setPrompt] = useState('')
  const [model, setModel] = useState('')
  const [size, setSize] = useState('')
  const [factor, setFactor] = useState<number | null>(null)

  const cropSurfaceRef = useRef<HTMLDivElement | null>(null)
  const redrawSurfaceRef = useRef<HTMLDivElement | null>(null)
  const cropStartRef = useRef<CanvasImagePoint | null>(null)
  const drawingRef = useRef(false)
  const draftRef = useRef<CanvasImageMaskStroke | null>(null)
  const lastOpenRef = useRef<string | null>(null)

  const tool = props.tool
  const sourceSize = props.sourceSize

  // Every opening starts from fresh controls; the source arrives async, so the
  // defaults that depend on its size are re-applied once it is measured.
  useEffect(() => {
    if (tool === null) {
      lastOpenRef.current = null
      return
    }
    const key = `${tool}:${props.source?.length ?? 0}`
    if (lastOpenRef.current === key) return
    lastOpenRef.current = key
    setCropRect(
      sourceSize
        ? { x: 0, y: 0, width: sourceSize.width, height: sourceSize.height }
        : null
    )
    setStrokes([])
    setDraft(null)
    draftRef.current = null
    drawingRef.current = false
    setPrompt('')
    setSize('')
    setModel(props.models[0]?.value ?? '')
    setFactor(
      sourceSize
        ? (availableCanvasImageUpscaleFactors(sourceSize)[0] ?? null)
        : null
    )
  }, [props.models, props.source, sourceSize, tool])

  const ready = props.source !== null && sourceSize !== null
  const upscaleFactors = sourceSize
    ? availableCanvasImageUpscaleFactors(sourceSize)
    : []
  const cropUsable =
    cropRect !== null && sourceSize !== null
      ? isCanvasImageCropUsable(cropRect, sourceSize)
      : false
  const redrawProblem = canvasImageRedrawError({ prompt, model, strokes })
  const maskStrokes = draft ? [...strokes, draft] : strokes

  const updateCropField = (key: keyof CanvasImageCropRect, value: number) => {
    if (!sourceSize) return
    const current = cropRect ?? {
      x: 0,
      y: 0,
      width: sourceSize.width,
      height: sourceSize.height,
    }
    setCropRect(
      clampCanvasImageCropRect(
        { ...current, [key]: Number.isFinite(value) ? value : 0 },
        sourceSize
      )
    )
  }

  const cropPointerPoint = (
    event: ReactPointerEvent<HTMLDivElement>
  ): CanvasImagePoint | null => {
    const bounds = cropSurfaceRef.current?.getBoundingClientRect()
    if (!bounds) return null
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top }
  }

  const handleCropPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (props.busy || props.disabled) return
    const point = cropPointerPoint(event)
    if (!point) return
    event.currentTarget.setPointerCapture?.(event.pointerId)
    cropStartRef.current = point
  }

  const handleCropPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = cropStartRef.current
    if (!start || !sourceSize) return
    const bounds = cropSurfaceRef.current?.getBoundingClientRect()
    const point = cropPointerPoint(event)
    if (!bounds || !point) return
    setCropRect(
      canvasImageCropRectFromDisplay(
        canvasImageCropRect(start, point),
        { width: bounds.width, height: bounds.height },
        sourceSize
      )
    )
  }

  const handleCropPointerUp = () => {
    cropStartRef.current = null
  }

  const redrawPointerPoint = (
    event: ReactPointerEvent<HTMLDivElement>
  ): CanvasImagePoint | null => {
    const bounds = redrawSurfaceRef.current?.getBoundingClientRect()
    if (!bounds || !sourceSize) return null
    return {
      x:
        (event.clientX - bounds.left) *
        canvasImageScale(bounds.width, sourceSize.width),
      y:
        (event.clientY - bounds.top) *
        canvasImageScale(bounds.height, sourceSize.height),
    }
  }

  const handleRedrawPointerDown = (
    event: ReactPointerEvent<HTMLDivElement>
  ) => {
    if (props.busy || props.disabled) return
    const point = redrawPointerPoint(event)
    if (!point) return
    event.currentTarget.setPointerCapture?.(event.pointerId)
    drawingRef.current = true
    const next: CanvasImageMaskStroke = { size: brushSize, points: [point] }
    draftRef.current = next
    setDraft(next)
  }

  const handleRedrawPointerMove = (
    event: ReactPointerEvent<HTMLDivElement>
  ) => {
    if (!drawingRef.current) return
    const point = redrawPointerPoint(event)
    const current = draftRef.current
    if (!point || !current) return
    const last = current.points[current.points.length - 1]
    if (last && Math.hypot(point.x - last.x, point.y - last.y) < 1) return
    const next: CanvasImageMaskStroke = {
      ...current,
      points: [...current.points, point],
    }
    draftRef.current = next
    setDraft(next)
  }

  const handleRedrawPointerUp = () => {
    if (!drawingRef.current) return
    drawingRef.current = false
    const stroke = draftRef.current
    draftRef.current = null
    setDraft(null)
    if (stroke && stroke.points.length > 0) {
      setStrokes((current) => [...current, stroke])
    }
  }

  const handleCrop = async () => {
    if (!cropRect || !cropUsable) return
    await props.onCrop(cropRect)
  }

  const handleRedraw = async () => {
    if (redrawProblem) return
    await props.onRedraw({
      prompt,
      model,
      strokes,
      ...(size ? { size } : {}),
    })
  }

  const handleUpscale = async () => {
    if (factor === null) return
    await props.onUpscale(factor)
  }

  const preview = props.source ? (
    <img
      alt=''
      className='block max-h-[50vh] w-auto max-w-full select-none'
      draggable={false}
      src={props.source}
    />
  ) : null

  const cropOverlayStyle =
    cropRect && sourceSize && sourceSize.width > 0 && sourceSize.height > 0
      ? {
          left: `${(cropRect.x / sourceSize.width) * 100}%`,
          top: `${(cropRect.y / sourceSize.height) * 100}%`,
          width: `${(cropRect.width / sourceSize.width) * 100}%`,
          height: `${(cropRect.height / sourceSize.height) * 100}%`,
        }
      : undefined

  const cropFields: { key: keyof CanvasImageCropRect; label: string }[] = [
    { key: 'x', label: t('Crop left (px)') },
    { key: 'y', label: t('Crop top (px)') },
    { key: 'width', label: t('Crop width (px)') },
    { key: 'height', label: t('Crop height (px)') },
  ]

  const cropBody = (
    <div className='grid gap-3'>
      <p className='text-muted-foreground text-xs'>
        {t(
          'Drag on the image to select the crop area, or enter the pixel values.'
        )}
      </p>
      <div
        className='relative mx-auto w-fit max-w-full cursor-crosshair touch-none overflow-hidden rounded-md border select-none'
        onPointerDown={handleCropPointerDown}
        onPointerMove={handleCropPointerMove}
        onPointerUp={handleCropPointerUp}
        ref={cropSurfaceRef}
      >
        {preview}
        {cropOverlayStyle ? (
          <div
            aria-hidden='true'
            className='border-primary bg-primary/20 pointer-events-none absolute border'
            style={cropOverlayStyle}
          />
        ) : null}
      </div>
      <div className='grid grid-cols-2 gap-2'>
        {cropFields.map((field) => (
          <label className='grid gap-1' key={field.key}>
            <span className='text-muted-foreground text-xs'>{field.label}</span>
            <Input
              disabled={props.busy || props.disabled}
              min={0}
              onChange={(event) =>
                updateCropField(
                  field.key,
                  event.target.value === '' ? 0 : Number(event.target.value)
                )
              }
              type='number'
              value={cropRect ? cropRect[field.key] : ''}
            />
          </label>
        ))}
      </div>
      <Button
        disabled={props.busy || props.disabled}
        onClick={() => {
          if (sourceSize) {
            setCropRect({
              x: 0,
              y: 0,
              width: sourceSize.width,
              height: sourceSize.height,
            })
          }
        }}
        size='sm'
        type='button'
        variant='outline'
      >
        {t('Select full image')}
      </Button>
    </div>
  )

  const redrawBody = (
    <div className='grid gap-3'>
      <p className='text-muted-foreground text-xs'>
        {t(CANVAS_IMAGE_TOOL_MESSAGES.MASK_EMPTY)}
      </p>
      <div
        className='relative mx-auto w-fit max-w-full cursor-crosshair touch-none overflow-hidden rounded-md border select-none'
        onPointerDown={handleRedrawPointerDown}
        onPointerMove={handleRedrawPointerMove}
        onPointerUp={handleRedrawPointerUp}
        ref={redrawSurfaceRef}
      >
        {preview}
        {sourceSize ? (
          <svg
            aria-hidden='true'
            className='pointer-events-none absolute inset-0 h-full w-full'
            preserveAspectRatio='none'
            viewBox={`0 0 ${sourceSize.width} ${sourceSize.height}`}
          >
            {maskStrokes.map((stroke, index) =>
              stroke.points.length === 1 ? (
                <circle
                  cx={stroke.points[0].x}
                  cy={stroke.points[0].y}
                  fill='rgba(239, 68, 68, 0.6)'
                  key={index}
                  r={Math.max(1, stroke.size) / 2}
                />
              ) : (
                <path
                  d={stroke.points
                    .map(
                      (point, pointIndex) =>
                        `${pointIndex === 0 ? 'M' : 'L'}${point.x} ${point.y}`
                    )
                    .join(' ')}
                  fill='none'
                  key={index}
                  stroke='rgba(239, 68, 68, 0.6)'
                  strokeLinecap='round'
                  strokeLinejoin='round'
                  strokeWidth={Math.max(1, stroke.size)}
                />
              )
            )}
          </svg>
        ) : null}
      </div>
      <div className='flex flex-wrap items-end gap-3'>
        <label className='grid gap-1.5'>
          <span className='text-muted-foreground text-xs'>
            {t('Brush size')}
          </span>
          <NativeSelect
            disabled={props.busy || props.disabled}
            onChange={(event) => setBrushSize(Number(event.target.value))}
            value={String(brushSize)}
          >
            {CANVAS_IMAGE_TOOL_BRUSH_SIZES.map((option) => (
              <NativeSelectOption key={option} value={String(option)}>
                {`${option} px`}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
        <Button
          disabled={props.busy || props.disabled || strokes.length === 0}
          onClick={() => setStrokes([])}
          size='sm'
          type='button'
          variant='outline'
        >
          {t('Clear mask')}
        </Button>
      </div>
      <label className='grid gap-1.5'>
        <span className='text-muted-foreground text-xs'>
          {t('Describe the change')}
        </span>
        <Textarea
          aria-label={t('Describe the change')}
          disabled={props.busy || props.disabled}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder={t(CANVAS_IMAGE_TOOL_MESSAGES.PROMPT_REQUIRED)}
          value={prompt}
        />
      </label>
      <label className='grid gap-1.5'>
        <span className='text-muted-foreground text-xs'>{t('Model')}</span>
        <NativeSelect
          disabled={props.busy || props.disabled || props.models.length === 0}
          onChange={(event) => setModel(event.target.value)}
          value={model}
        >
          {props.models.length === 0 ? (
            <NativeSelectOption value=''>
              {t('No models available')}
            </NativeSelectOption>
          ) : null}
          {props.models.map((option) => (
            <NativeSelectOption key={option.value} value={option.value}>
              {option.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </label>
      <label className='grid gap-1.5'>
        <span className='text-muted-foreground text-xs'>{t('Size')}</span>
        <NativeSelect
          disabled={props.busy || props.disabled}
          onChange={(event) => setSize(event.target.value)}
          value={size}
        >
          <NativeSelectOption value=''>
            {t('Channel default')}
          </NativeSelectOption>
          {PLAYGROUND_IMAGE_SIZES.map((option) => (
            <NativeSelectOption key={option} value={option}>
              {CANVAS_WORKFLOW_IMAGE_SIZE_RATIOS[option]
                ? `${option} · ${CANVAS_WORKFLOW_IMAGE_SIZE_RATIOS[option]}`
                : option}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </label>
    </div>
  )

  const upscaleBody = (
    <div className='grid gap-3'>
      <div className='mx-auto w-fit max-w-full'>{preview}</div>
      <label className='grid gap-1.5'>
        <span className='text-muted-foreground text-xs'>
          {t('Scale factor')}
        </span>
        <NativeSelect
          disabled={props.busy || props.disabled || upscaleFactors.length === 0}
          onChange={(event) =>
            setFactor(
              event.target.value === '' ? null : Number(event.target.value)
            )
          }
          value={factor === null ? '' : String(factor)}
        >
          {upscaleFactors.length === 0 ? (
            <NativeSelectOption value=''>
              {t(CANVAS_IMAGE_TOOL_MESSAGES.UPSCALE_UNAVAILABLE)}
            </NativeSelectOption>
          ) : null}
          {upscaleFactors.map((option) => (
            <NativeSelectOption key={option} value={String(option)}>
              {`${option}×`}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </label>
      {sourceSize && factor !== null ? (
        <p className='text-muted-foreground text-xs'>
          {`${sourceSize.width} × ${sourceSize.height} → ${Math.round(
            sourceSize.width * factor
          )} × ${Math.round(sourceSize.height * factor)}`}
        </p>
      ) : null}
      <p className='text-muted-foreground text-xs'>
        {t(
          'The output keeps the aspect ratio and is limited to 4096 pixels on the longest edge.'
        )}
      </p>
    </div>
  )

  return (
    <Dialog
      description={t('The result is added as a new node linked to this image.')}
      footer={
        tool ? (
          <div className='flex flex-wrap justify-end gap-2'>
            <Button
              disabled={props.busy}
              onClick={props.onClose}
              type='button'
              variant='outline'
            >
              {t('Cancel')}
            </Button>
            {tool === 'crop' ? (
              <Button
                disabled={props.busy || props.disabled || !cropUsable}
                onClick={() => void handleCrop()}
                type='button'
              >
                {props.busy ? (
                  <Loader2 aria-hidden='true' className='animate-spin' />
                ) : null}
                {t('Apply crop')}
              </Button>
            ) : null}
            {tool === 'redraw' ? (
              <Button
                disabled={
                  props.busy || props.disabled || redrawProblem !== null
                }
                onClick={() => void handleRedraw()}
                type='button'
              >
                {props.busy ? (
                  <Loader2 aria-hidden='true' className='animate-spin' />
                ) : null}
                {t('Apply redraw')}
              </Button>
            ) : null}
            {tool === 'upscale' ? (
              <Button
                disabled={props.busy || props.disabled || factor === null}
                onClick={() => void handleUpscale()}
                type='button'
              >
                {props.busy ? (
                  <Loader2 aria-hidden='true' className='animate-spin' />
                ) : null}
                {t('Apply upscale')}
              </Button>
            ) : null}
          </div>
        ) : null
      }
      onOpenChange={(open) => {
        if (!open && !props.busy) props.onClose()
      }}
      open={tool !== null}
      showCloseButton={!props.busy}
      title={tool ? t(CANVAS_IMAGE_TOOL_TITLES[tool]) : t('Image tools')}
    >
      {ready ? (
        <div className='grid gap-3'>
          {tool === 'crop' ? cropBody : null}
          {tool === 'redraw' ? redrawBody : null}
          {tool === 'upscale' ? upscaleBody : null}
        </div>
      ) : (
        <p className='text-muted-foreground text-sm'>{t('Loading image...')}</p>
      )}
    </Dialog>
  )
}
