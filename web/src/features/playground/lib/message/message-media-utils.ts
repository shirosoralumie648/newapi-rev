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
  HISTORY_IMAGES_OMITTED_CONTENT,
  HISTORY_IMAGE_OMITTED_CONTENT,
  INLINE_BASE64_OMITTED_CONTENT,
  MESSAGE_ROLES,
} from '../../constants'
import type { ChatCompletionMessage, ContentPart } from '../../types'

// Markdown links and images whose target is an inline data URL. Base64 never
// contains ")", so the whole link can be replaced by one placeholder.
const INLINE_MARKDOWN_MEDIA_PATTERN = /!?\[[^\]]*\]\(\s*data:[^)]*\)/gi
// An <img> tag with an inline source, including surrounding attributes.
const INLINE_HTML_IMAGE_PATTERN =
  /<img\b[^>]*\bsrc\s*=\s*["']data:[^"']*["'][^>]*>/gi
// A data URL embedded directly in text. This is the last pass, so a URL that
// belongs to a Markdown link or an image tag has already been replaced.
const INLINE_DATA_URL_PATTERN = /data:[^,\s]+;base64,[a-z0-9+/=_-]+/gi

// A text-only model rejects a request that carries image parts. The catalog
// has no capability metadata, so the Playground uses two name lists instead:
// a match in the vision list keeps images, and a match in the text-only list
// turns images from earlier turns into placeholders.
const VISION_MODEL_MARKERS = [
  'gemini',
  'claude-3',
  'claude-4',
  'claude-opus',
  'claude-sonnet',
  'claude-haiku',
  'gpt-4o',
  'gpt-4.1',
  'gpt-4-turbo',
  'gpt-4.5',
  'gpt-5',
  'chatgpt',
  'vision',
  '-vl',
  '4v',
  'glm-4v',
  'glm-4.5v',
  'glm-4.6v',
  'omni',
  'multimodal',
  'llava',
  'pixtral',
  'internvl',
  'minicpm-v',
  'gemma-3',
  'llama-4',
  'llama-3.2',
  'nova-',
  'step-1v',
  'molmo',
  'ovis',
]

const TEXT_ONLY_MODEL_MARKERS = [
  'deepseek',
  'gpt-3.5',
  'gpt-4',
  'o1-mini',
  'o1-preview',
  'o3-mini',
  'qwen-turbo',
  'qwen-plus',
  'qwen-max',
  'qwen-long',
  'qwen2.5',
  'qwen3',
  'glm-4-flash',
  'glm-4-air',
  'glm-4-plus',
  'glm-4.5',
  'glm-4.6',
  'moonshot-v1',
  'kimi-k2',
  'llama-2',
  'llama-3',
  'mistral-large',
  'mistral-medium',
  'command-r',
  'gemma-2',
  'phi-3',
  'phi-4',
  'ernie-3.5',
  'ernie-4.0',
  'ernie-speed',
  'hunyuan-turbo',
  'hunyuan-large',
  'yi-large',
  'yi-medium',
  'yi-lightning',
  'yi-spark',
  'step-2',
  'abab',
  'claude-2',
  'claude-instant',
]

/**
 * Replaces inline base64 media in stored text with a short placeholder. The
 * bytes are never useful as model input: a chat model cannot consume an image
 * from its text, and forwarding a base64 data URL produced by an image model
 * multiplies the request size on every later turn. The original stored message
 * is left untouched.
 */
export function omitInlineBase64Media(text: string): {
  text: string
  omitted: number
} {
  if (!text.includes('data:')) {
    return { text, omitted: 0 }
  }
  let omitted = 0
  const replace = (value: string, pattern: RegExp): string =>
    value.replace(pattern, () => {
      omitted += 1
      return INLINE_BASE64_OMITTED_CONTENT
    })
  let scrubbed = replace(text, INLINE_MARKDOWN_MEDIA_PATTERN)
  scrubbed = replace(scrubbed, INLINE_HTML_IMAGE_PATTERN)
  scrubbed = replace(scrubbed, INLINE_DATA_URL_PATTERN)
  return { text: scrubbed, omitted }
}

/**
 * Whether the model is expected to accept image parts. A model the lists do
 * not recognize is treated as accepting images: keeping an unwanted part makes
 * the upstream reject the request visibly, while dropping a supported image
 * would silently change what the user asked about.
 */
export function modelAcceptsImageInput(model: string): boolean {
  const normalized = model.trim().toLowerCase()
  if (!normalized) return true
  if (VISION_MODEL_MARKERS.some((marker) => normalized.includes(marker))) {
    return true
  }
  if (TEXT_ONLY_MODEL_MARKERS.some((marker) => normalized.includes(marker))) {
    return false
  }
  return true
}

export interface ModelMediaPolicyResult {
  /** Request messages after inline media scrubbing and image filtering. */
  messages: ChatCompletionMessage[]
  /** Inline base64 data URLs replaced by a placeholder. */
  omittedInlineImages: number
  /** Structured image parts removed because the model is text-only. */
  omittedHistoryImages: number
  /** All images the request no longer carries, for the context notice. */
  omittedImages: number
}

/**
 * Adjusts one outgoing request to the selected model without changing stored
 * messages. Inline base64 data is always replaced. When the model is known to
 * be text-only, structured images before the newest user turn are replaced by
 * a text placeholder; the newest user turn keeps its attachments so attaching
 * an image to a text-only model still produces the upstream error instead of
 * silently dropping the attachment.
 */
export function applyModelMediaPolicy(
  messages: ChatCompletionMessage[],
  model: string
): ModelMediaPolicyResult {
  const acceptsImages = modelAcceptsImageInput(model)
  let newestUserIndex = -1
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === MESSAGE_ROLES.USER) {
      newestUserIndex = index
      break
    }
  }

  let omittedInlineImages = 0
  let omittedHistoryImages = 0
  const adjusted = messages.map((message, index) => {
    if (typeof message.content === 'string') {
      const scrubbed = omitInlineBase64Media(message.content)
      omittedInlineImages += scrubbed.omitted
      return scrubbed.text === message.content
        ? message
        : { ...message, content: scrubbed.text }
    }

    const parts: ContentPart[] = []
    let changed = false
    let omittedImagesHere = 0
    for (const part of message.content) {
      if (part.type === 'text' && part.text) {
        const scrubbed = omitInlineBase64Media(part.text)
        omittedInlineImages += scrubbed.omitted
        if (scrubbed.text !== part.text) {
          changed = true
          parts.push({ ...part, text: scrubbed.text })
        } else {
          parts.push(part)
        }
        continue
      }
      if (
        part.type === 'image_url' &&
        !acceptsImages &&
        index < newestUserIndex
      ) {
        changed = true
        omittedImagesHere += 1
        continue
      }
      parts.push(part)
    }
    if (omittedImagesHere > 0) {
      omittedHistoryImages += omittedImagesHere
      parts.push({
        type: 'text',
        text:
          omittedImagesHere === 1
            ? HISTORY_IMAGE_OMITTED_CONTENT
            : HISTORY_IMAGES_OMITTED_CONTENT.replace(
                '{{count}}',
                String(omittedImagesHere)
              ),
      })
    }
    return changed ? { ...message, content: parts } : message
  })

  return {
    messages: adjusted,
    omittedInlineImages,
    omittedHistoryImages,
    omittedImages: omittedInlineImages + omittedHistoryImages,
  }
}
