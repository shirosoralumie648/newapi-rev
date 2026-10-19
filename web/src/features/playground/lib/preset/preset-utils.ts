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
import type { PlaygroundPresetInput } from '../../api'
import type {
  AssistantPreset,
  ParameterEnabled,
  PlaygroundConfig,
} from '../../types'

export type PlaygroundSessionSettings = {
  config: PlaygroundConfig
  parameterEnabled: ParameterEnabled
  systemPrompt: string
  openingMessage: string
  suggestedQuestions: string[]
}

/**
 * The settings a preset contributes to a conversation: its model and sampling
 * parameters, its parameter flags and its system prompt. Routing (`group`) and
 * transport (`stream`) always stay as the conversation configured them, so a
 * preset can never switch a user to a group they did not choose.
 */
export function presetSessionSettings(
  preset: AssistantPreset,
  base: { config: PlaygroundConfig; parameterEnabled: ParameterEnabled }
): PlaygroundSessionSettings {
  return {
    config: {
      ...base.config,
      model: preset.config.model || base.config.model,
      temperature: preset.config.temperature,
      top_p: preset.config.top_p,
      max_tokens: preset.config.max_tokens,
      frequency_penalty: preset.config.frequency_penalty,
      presence_penalty: preset.config.presence_penalty,
      seed: preset.config.seed,
      reasoning_effort: preset.config.reasoning_effort,
    },
    parameterEnabled: { ...preset.parameterEnabled },
    systemPrompt: preset.systemPrompt,
    openingMessage: preset.openingMessage,
    suggestedQuestions: [...preset.suggestedQuestions],
  }
}

/**
 * Captures reusable settings as a preset payload. Only the model, sampling
 * parameters, parameter flags and system prompt are copied; routing and
 * transport stay out of the preset.
 */
export function presetInputFromSettings(
  name: string,
  avatar: string,
  settings: PlaygroundSessionSettings
): PlaygroundPresetInput {
  return {
    name: name.trim(),
    avatar: avatar.trim(),
    config: {
      model: settings.config.model,
      temperature: settings.config.temperature,
      top_p: settings.config.top_p,
      max_tokens: settings.config.max_tokens,
      frequency_penalty: settings.config.frequency_penalty,
      presence_penalty: settings.config.presence_penalty,
      seed: settings.config.seed,
      reasoning_effort: settings.config.reasoning_effort,
    },
    parameter_enabled: { ...settings.parameterEnabled },
    system_prompt: settings.systemPrompt,
    opening_message: settings.openingMessage,
    suggested_questions: settings.suggestedQuestions,
  }
}

/**
 * A preset avatar renders as an image only for http(s) URLs; every other value
 * (for example an emoji) is shown as text and never fetched.
 */
export function presetAvatarUrl(avatar: string): string | null {
  return /^https?:\/\/\S+$/i.test(avatar) ? avatar : null
}
