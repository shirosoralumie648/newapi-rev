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
  PLAYGROUND_GENERATION_ADJUSTMENTS,
  PLAYGROUND_GENERATION_BATCH_MESSAGES,
  PLAYGROUND_GENERATION_COMPARE_MAX,
  PLAYGROUND_GENERATION_SEED_MAX,
  PLAYGROUND_GENERATION_SEED_MIN,
  PLAYGROUND_GENERATION_VARIATION_MAX,
  PLAYGROUND_GENERATION_VARIATION_MIN,
  PLAYGROUND_IMAGE_MAX_COUNT,
  PLAYGROUND_IMAGE_QUALITIES,
  PLAYGROUND_IMAGE_SIZES,
  PLAYGROUND_VIDEO_DURATIONS,
  PLAYGROUND_VIDEO_MAX_DURATION_SECONDS,
  PLAYGROUND_VIDEO_SIZES,
} from '../../constants'
import type { PlaygroundGenerationKind } from '../../types'

/** The media kinds a reproducible batch can run; audio has no seed grid. */
export type GenerationBatchKind = Exclude<PlaygroundGenerationKind, 'audio'>

/** How a seed grid advances between requests. */
export type GenerationSeedMode = 'increment' | 'random'

/**
 * The capability limits one model reports for a kind. Undefined lists mean the
 * catalog proved nothing, so every value the form offers stays allowed;
 * `false` (not undefined) is an explicit capability gap.
 */
export interface GenerationCapabilityLimits {
  image?: boolean
  video?: boolean
  sizes?: readonly string[]
  qualities?: readonly string[]
  durations?: readonly number[]
}

/**
 * One parameter the plan had to map for a model. The requested value is kept,
 * so the interface can show exactly what changed instead of silently
 * rewriting the user's form.
 */
export interface GenerationAdjustment {
  field: 'size' | 'quality' | 'duration'
  from: string
  to: string
  messageKey: string
}

/** The bounded request parameters resolved for one model. */
export interface GenerationRequestParams {
  supported: boolean
  messageKey?: string
  size?: string
  quality?: string
  duration?: number
  adjustments: GenerationAdjustment[]
}

/** One relay request the panel is about to send. */
export interface GenerationBatchRequest {
  id: string
  kind: GenerationBatchKind
  model: string
  prompt: string
  group: string
  seed: number
  count?: number
  size?: string
  quality?: string
  duration?: number
  adjustments: GenerationAdjustment[]
}

/** A model the plan refused because its catalog reports no such capability. */
export interface GenerationBatchBlockedModel {
  model: string
  messageKey: string
}

export interface GenerationBatchPlan {
  mode: 'variations' | 'compare'
  kind: GenerationBatchKind
  prompt: string
  group: string
  requests: GenerationBatchRequest[]
  blocked: GenerationBatchBlockedModel[]
  /** Why the plan cannot run; absent when `requests` is usable. */
  errorKey?: string
}

export interface GenerationBatchPlanInput {
  mode: 'variations' | 'compare'
  kind: GenerationBatchKind
  prompt: string
  group: string
  models: string[]
  variationCount?: number
  seedMode?: GenerationSeedMode
  baseSeed?: number
  /** Injected by tests; production uses crypto-backed randomness. */
  randomSeed?: () => number
  size?: string
  quality?: string
  duration?: number
  limits?: Record<string, GenerationCapabilityLimits | undefined>
}

/** Per-model generation options merged from the task usage schemas. */
export interface GenerationSchemaOptions {
  imageSizes: string[]
  videoSizes: string[]
  qualities: string[]
  durations: number[]
}

export function emptyGenerationSchemaOptions(): GenerationSchemaOptions {
  return { imageSizes: [], videoSizes: [], qualities: [], durations: [] }
}

/**
 * Keeps a variation grid inside both the interface bound and the relay's
 * `dto.MaxImageN`, because every variation is one real request.
 */
export function clampGenerationVariationCount(count: number): number {
  if (!Number.isFinite(count)) return PLAYGROUND_GENERATION_VARIATION_MIN
  const max = Math.min(
    PLAYGROUND_GENERATION_VARIATION_MAX,
    PLAYGROUND_IMAGE_MAX_COUNT
  )
  const whole = Math.trunc(count)
  if (whole < PLAYGROUND_GENERATION_VARIATION_MIN) {
    return PLAYGROUND_GENERATION_VARIATION_MIN
  }
  return Math.min(whole, max)
}

/** Trims and de-duplicates a model selection while preserving its order. */
export function normalizeGenerationModels(models: readonly string[]): string[] {
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const raw of models) {
    const model = raw.trim()
    if (!model || seen.has(model)) continue
    seen.add(model)
    normalized.push(model)
  }
  return normalized
}

function generationSeedSpan(): number {
  return PLAYGROUND_GENERATION_SEED_MAX - PLAYGROUND_GENERATION_SEED_MIN + 1
}

function normalizeWholeSeed(seed: number): number {
  const span = generationSeedSpan()
  const whole = Number.isFinite(seed) ? Math.trunc(seed) : 0
  return (((whole % span) + span) % span) + PLAYGROUND_GENERATION_SEED_MIN
}

/** A fresh explicit seed; a blank seed never reaches the provider as zero. */
export function generationRandomSeed(): number {
  const values = new Uint32Array(1)
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.getRandomValues === 'function'
  ) {
    crypto.getRandomValues(values)
  } else {
    values[0] = Math.floor(Math.random() * 0xffffffff)
  }
  return normalizeWholeSeed(values[0] ?? 0)
}

export function normalizeGenerationSeed(
  seed: number | undefined,
  randomSeed: () => number = generationRandomSeed
): number {
  if (
    seed !== undefined &&
    Number.isInteger(seed) &&
    seed >= PLAYGROUND_GENERATION_SEED_MIN &&
    seed <= PLAYGROUND_GENERATION_SEED_MAX
  ) {
    return seed
  }
  return normalizeWholeSeed(randomSeed())
}

/**
 * Builds the seeds of one variation grid. Increment wraps inside the accepted
 * range; random rejects duplicates so every variation asks for a different
 * result. A degenerate random source falls back to a deterministic increment
 * instead of returning fewer seeds than requested.
 */
export function generationSeedGrid(options: {
  count: number
  mode: GenerationSeedMode
  baseSeed?: number
  randomSeed?: () => number
}): number[] {
  const count = clampGenerationVariationCount(options.count)
  const randomSeed = options.randomSeed ?? generationRandomSeed
  const base = normalizeGenerationSeed(options.baseSeed, randomSeed)
  if (options.mode === 'random') {
    const seeds: number[] = []
    const seen = new Set<number>()
    for (
      let attempt = 0;
      attempt < count * 100 && seeds.length < count;
      attempt++
    ) {
      const seed = normalizeWholeSeed(randomSeed())
      if (seen.has(seed)) continue
      seen.add(seed)
      seeds.push(seed)
    }
    let offset = 0
    while (seeds.length < count && offset < generationSeedSpan()) {
      const seed = normalizeWholeSeed(base + offset)
      offset += 1
      if (seen.has(seed)) continue
      seen.add(seed)
      seeds.push(seed)
    }
    return seeds
  }
  const span = generationSeedSpan()
  const seeds: number[] = []
  for (let index = 0; index < count; index++) {
    seeds.push(
      ((base - PLAYGROUND_GENERATION_SEED_MIN + index) % span) +
        PLAYGROUND_GENERATION_SEED_MIN
    )
  }
  return seeds
}

function parseDimensionSize(
  value: string
): { width: number; height: number } | null {
  const match = /^([0-9]+)[xX]([0-9]+)$/.exec(value.trim())
  if (!match) return null
  const width = Number(match[1])
  const height = Number(match[2])
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null
  }
  return { width, height }
}

/**
 * Picks the allowed size closest to the requested one: aspect ratio first,
 * then area, so a square request never becomes a strong landscape.
 */
function closestGenerationSize(
  requested: string,
  allowed: readonly string[]
): string {
  const target = parseDimensionSize(requested)
  const candidates = allowed
    .map((value) => ({ value, parsed: parseDimensionSize(value) }))
    .filter(
      (
        candidate
      ): candidate is {
        value: string
        parsed: { width: number; height: number }
      } => candidate.parsed !== null
    )
  if (!target || candidates.length === 0) return allowed[0] ?? requested
  const requestedArea = target.width * target.height
  let best = candidates[0]
  let bestScore = Number.POSITIVE_INFINITY
  for (const candidate of candidates) {
    const { width, height } = candidate.parsed
    const candidateArea = width * height
    const cross = Math.abs(target.width * height - width * target.height)
    const ratioScore =
      cross / Math.max(1, target.width * height + width * target.height)
    const areaScore =
      Math.abs(requestedArea - candidateArea) / Math.max(1, requestedArea)
    const score = ratioScore + areaScore
    if (score < bestScore) {
      bestScore = score
      best = candidate
    }
  }
  return best.value
}

function closestGenerationDuration(
  requested: number,
  allowed: readonly number[]
): number {
  let best = allowed[0] ?? requested
  let bestDistance = Number.POSITIVE_INFINITY
  for (const candidate of allowed) {
    const distance = Math.abs(candidate - requested)
    if (distance < bestDistance) {
      bestDistance = distance
      best = candidate
    }
  }
  return best
}

/**
 * Maps one model's requested parameters onto its capability limits. An
 * explicit capability gap refuses the request with a translatable message; a
 * missing value is reported as an adjustment, never applied silently.
 */
export function resolveGenerationRequestParams(input: {
  kind: GenerationBatchKind
  model: string
  requested: { size?: string; quality?: string; duration?: number }
  limits?: GenerationCapabilityLimits
}): GenerationRequestParams {
  const limits = input.limits ?? {}
  if (input.kind === 'image' && limits.image === false) {
    return {
      supported: false,
      messageKey: PLAYGROUND_GENERATION_BATCH_MESSAGES.IMAGE_UNSUPPORTED,
      adjustments: [],
    }
  }
  if (input.kind === 'video' && limits.video === false) {
    return {
      supported: false,
      messageKey: PLAYGROUND_GENERATION_BATCH_MESSAGES.VIDEO_UNSUPPORTED,
      adjustments: [],
    }
  }
  const adjustments: GenerationAdjustment[] = []
  const result: GenerationRequestParams = { supported: true, adjustments }
  const size = input.requested.size?.trim()
  if (size) {
    if (!limits.sizes || limits.sizes.includes(size)) {
      result.size = size
    } else {
      const applied = closestGenerationSize(size, limits.sizes)
      result.size = applied
      adjustments.push({
        field: 'size',
        from: size,
        to: applied,
        messageKey: PLAYGROUND_GENERATION_ADJUSTMENTS.SIZE,
      })
    }
  }
  if (input.kind === 'image') {
    const quality = input.requested.quality?.trim()
    if (quality) {
      if (!limits.qualities || limits.qualities.includes(quality)) {
        result.quality = quality
      } else {
        adjustments.push({
          field: 'quality',
          from: quality,
          to: '',
          messageKey: PLAYGROUND_GENERATION_ADJUSTMENTS.QUALITY,
        })
      }
    }
    return result
  }
  const duration = input.requested.duration
  if (duration !== undefined && Number.isFinite(duration)) {
    const bounded = Math.min(
      Math.max(Math.trunc(duration), 1),
      PLAYGROUND_VIDEO_MAX_DURATION_SECONDS
    )
    if (
      !limits.durations ||
      limits.durations.length === 0 ||
      limits.durations.includes(bounded)
    ) {
      result.duration = bounded
    } else {
      const applied = closestGenerationDuration(bounded, limits.durations)
      result.duration = applied
      adjustments.push({
        field: 'duration',
        from: String(bounded),
        to: String(applied),
        messageKey: PLAYGROUND_GENERATION_ADJUSTMENTS.DURATION,
      })
    }
  }
  return result
}

/**
 * Builds one bounded batch: a seed grid over one model, or one request per
 * compared model sharing a single seed. Every request keeps its resolved
 * parameters and adjustments, so the run and its results stay traceable.
 */
export function buildGenerationBatchPlan(
  input: GenerationBatchPlanInput
): GenerationBatchPlan {
  const prompt = input.prompt.trim()
  const models = normalizeGenerationModels(input.models)
  const emptyPlan = (errorKey: string): GenerationBatchPlan => ({
    mode: input.mode,
    kind: input.kind,
    prompt,
    group: input.group,
    requests: [],
    blocked: [],
    errorKey,
  })
  if (!prompt) {
    return emptyPlan(PLAYGROUND_GENERATION_BATCH_MESSAGES.PROMPT_REQUIRED)
  }
  if (models.length === 0) {
    return emptyPlan(PLAYGROUND_GENERATION_BATCH_MESSAGES.MODEL_REQUIRED)
  }
  if (
    input.mode === 'compare' &&
    (models.length < PLAYGROUND_GENERATION_COMPARE_MIN ||
      models.length > PLAYGROUND_GENERATION_COMPARE_MAX)
  ) {
    return emptyPlan(PLAYGROUND_GENERATION_BATCH_MESSAGES.COMPARE_SELECTION)
  }
  const selectedModels = input.mode === 'compare' ? models : models.slice(0, 1)
  const seeds =
    input.mode === 'compare'
      ? [normalizeGenerationSeed(input.baseSeed, input.randomSeed)]
      : generationSeedGrid({
          count: input.variationCount ?? 1,
          mode: input.seedMode ?? 'increment',
          baseSeed: input.baseSeed,
          randomSeed: input.randomSeed,
        })
  const requests: GenerationBatchRequest[] = []
  const blocked: GenerationBatchBlockedModel[] = []
  for (const model of selectedModels) {
    const resolved = resolveGenerationRequestParams({
      kind: input.kind,
      model,
      requested: {
        size: input.size,
        quality: input.quality,
        duration: input.duration,
      },
      limits: input.limits?.[model],
    })
    if (!resolved.supported) {
      blocked.push({
        model,
        messageKey:
          resolved.messageKey ??
          PLAYGROUND_GENERATION_BATCH_MESSAGES.IMAGE_UNSUPPORTED,
      })
      continue
    }
    const requestCount = input.mode === 'compare' ? 1 : seeds.length
    for (let index = 0; index < requestCount; index++) {
      const seed =
        (input.mode === 'compare' ? seeds[0] : seeds[index]) ?? seeds[0]
      requests.push({
        id: `${input.mode}-${requests.length}`,
        kind: input.kind,
        model,
        prompt,
        group: input.group,
        seed,
        ...(input.kind === 'image' ? { count: 1 } : {}),
        ...(resolved.size ? { size: resolved.size } : {}),
        ...(resolved.quality ? { quality: resolved.quality } : {}),
        ...(input.kind === 'video' && resolved.duration !== undefined
          ? { duration: resolved.duration }
          : {}),
        adjustments: resolved.adjustments,
      })
    }
  }
  return {
    mode: input.mode,
    kind: input.kind,
    prompt,
    group: input.group,
    requests,
    blocked,
  }
}

/**
 * Merges the enum values of one task usage schema into a model's generation
 * options. Sizes and resolutions feed the video list; only WIDTHxHEIGHT values
 * feed the image list, because image endpoints accept concrete dimensions
 * while a tier label is a billing fact, not a request parameter.
 */
export function collectGenerationSchemaOptions(
  current: GenerationSchemaOptions,
  schema: Record<string, { enum?: readonly string[] } | undefined> | undefined,
  support: { image: boolean; video: boolean }
): GenerationSchemaOptions {
  if (!schema) return current
  const imageSizes = new Set(current.imageSizes)
  const videoSizes = new Set(current.videoSizes)
  const qualities = new Set(current.qualities)
  const durations = new Set(current.durations)
  for (const [field, definition] of Object.entries(schema)) {
    const values = definition?.enum
    if (!values || values.length === 0) continue
    if (field === 'size' || field === 'resolution') {
      for (const value of values) {
        if (!value) continue
        if (parseDimensionSize(value)) {
          if (support.image) imageSizes.add(value)
          if (support.video) videoSizes.add(value)
          continue
        }
        if (support.video) videoSizes.add(value)
      }
      continue
    }
    if (field === 'quality') {
      if (!support.image) continue
      for (const value of values) {
        if (value) qualities.add(value)
      }
      continue
    }
    if (field === 'duration' || field === 'seconds') {
      for (const value of values) {
        const parsed = Number(value)
        if (
          Number.isInteger(parsed) &&
          parsed > 0 &&
          parsed <= PLAYGROUND_VIDEO_MAX_DURATION_SECONDS
        ) {
          durations.add(parsed)
        }
      }
    }
  }
  return {
    imageSizes: [...imageSizes],
    videoSizes: [...videoSizes],
    qualities: [...qualities],
    durations: [...durations],
  }
}

/**
 * Merges two per-model option sets, preserving first-seen order, so several
 * compared models offer the union of what any of them accepts.
 */
export function mergeGenerationSchemaOptions(
  target: GenerationSchemaOptions,
  source: GenerationSchemaOptions
): GenerationSchemaOptions {
  return {
    imageSizes: uniqueStrings([...target.imageSizes, ...source.imageSizes]),
    videoSizes: uniqueStrings([...target.videoSizes, ...source.videoSizes]),
    qualities: uniqueStrings([...target.qualities, ...source.qualities]),
    durations: uniqueNumbers([...target.durations, ...source.durations]),
  }
}

/**
 * The selectable values of one kind: the interface defaults plus everything
 * the model's catalog reported, so a requested value always stays visible
 * even when the plan will map it.
 */
export function generationOptionSets(
  kind: GenerationBatchKind,
  options?: GenerationSchemaOptions
): { sizes: string[]; qualities: string[]; durations: number[] } {
  if (kind === 'image') {
    return {
      sizes: uniqueStrings([
        ...PLAYGROUND_IMAGE_SIZES,
        ...(options?.imageSizes ?? []),
      ]),
      qualities: uniqueStrings([
        ...PLAYGROUND_IMAGE_QUALITIES,
        ...(options?.qualities ?? []),
      ]),
      durations: [],
    }
  }
  return {
    sizes: uniqueStrings([
      ...PLAYGROUND_VIDEO_SIZES,
      ...(options?.videoSizes ?? []),
    ]),
    qualities: [],
    durations: uniqueNumbers([
      ...PLAYGROUND_VIDEO_DURATIONS,
      ...(options?.durations ?? []),
    ]),
  }
}

/** Converts one model's catalog options into the plan's limits. */
export function generationLimits(
  kind: GenerationBatchKind,
  options: GenerationSchemaOptions | undefined,
  support: { image: boolean; video: boolean } | null
): GenerationCapabilityLimits {
  // An empty enum means the catalog did not report this parameter, not that
  // the model rejects every value; treating it as unrestricted keeps the
  // request untouched instead of reporting a no-op adjustment.
  const sizes = kind === 'image' ? options?.imageSizes : options?.videoSizes
  const qualities = kind === 'image' ? options?.qualities : undefined
  const durations = kind === 'video' ? options?.durations : undefined
  return {
    image: support?.image ?? true,
    video: support?.video ?? true,
    ...(sizes && sizes.length > 0 ? { sizes } : {}),
    ...(qualities && qualities.length > 0 ? { qualities } : {}),
    ...(durations && durations.length > 0 ? { durations } : {}),
  }
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function uniqueNumbers(values: readonly number[]): number[] {
  return [...new Set(values)]
}
