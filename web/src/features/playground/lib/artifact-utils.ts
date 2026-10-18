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
  getMarkdown,
  parseMarkdownToStructure,
  type CodeBlockNode,
  type ParsedNode,
} from 'stream-markdown-parser'

import type { PlaygroundArtifactKind } from '../artifact-api'

const parser = getMarkdown('playground-artifact-source', {
  enableMath: true,
  enableContainers: true,
})

export interface PlaygroundCodeSelection {
  index: number
  language: string
  content: string
  label: string
}

function collectCodeBlocks(nodes: ParsedNode[], output: CodeBlockNode[]): void {
  for (const node of nodes) {
    if (node.type === 'code_block' && 'code' in node && 'language' in node) {
      output.push(node as CodeBlockNode)
      continue
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'raw') continue
      if (Array.isArray(value)) {
        collectCodeBlocks(
          value.filter(
            (item): item is ParsedNode =>
              Boolean(item) && typeof item === 'object' && 'type' in item
          ),
          output
        )
      }
    }
  }
}

export function getPlaygroundCodeSelections(
  content: string
): PlaygroundCodeSelection[] {
  const parsed = parseMarkdownToStructure(content, parser, {
    final: true,
    validateLink: parser.options.validateLink,
  })
  const blocks: CodeBlockNode[] = []
  collectCodeBlocks(parsed, blocks)
  return blocks.map((block, index) => {
    const language = block.language.trim().toLowerCase() || 'plaintext'
    const lines = block.code.trim().split('\n')
    const excerpt = lines[0]?.trim() ?? ''
    return {
      index,
      language,
      content: block.code,
      label: `${language} · ${excerpt.slice(0, 72)}`,
    }
  })
}

export function getArtifactFilename(
  title: string,
  language: string,
  kind: PlaygroundArtifactKind
): string {
  const safe =
    title
      .normalize('NFKC')
      .replaceAll(/[\p{Cc}/\\:*?"<>|]/gu, '-')
      .replaceAll(/\s+/g, ' ')
      .trim()
      .replaceAll(/[. ]+$/g, '')
      .slice(0, 120) || 'artifact'
  let suffix = 'md'
  if (kind === 'html' || kind === 'svg') {
    suffix = kind
  } else if (kind === 'code') {
    const normalized = language.toLowerCase().replaceAll(/[^a-z0-9+#._-]/g, '')
    // Mirror CodeBlock: an unlabeled fence has no real extension.
    suffix =
      normalized === '' || normalized === 'plaintext' ? 'txt' : normalized
  }
  return `${safe}.${suffix}`
}

export function downloadArtifactText(
  title: string,
  language: string,
  kind: PlaygroundArtifactKind,
  content: string
): void {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = getArtifactFilename(title, language, kind)
  anchor.click()
  URL.revokeObjectURL(url)
}
