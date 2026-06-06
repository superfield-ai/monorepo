import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ParsedBlock } from './parse-text.js'

const execFileAsync = promisify(execFile)

export interface ParsedPdfBlock extends ParsedBlock {
  meta: { parse_confidence: number }
}

export async function parsePdf(pdfBuffer: Buffer): Promise<ParsedPdfBlock[]> {
  // Write PDF to temp file
  const tmpPath = join(tmpdir(), `nexum-pdf-${randomUUID()}.pdf`)
  await writeFile(tmpPath, pdfBuffer)

  let text: string
  try {
    const { stdout } = await execFileAsync('pdftotext', ['-layout', tmpPath, '-'])
    text = stdout
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      const error = new Error('pdftotext not found — install poppler-utils (apt-get install poppler-utils)') as any
      error.status = 400
      throw error
    }
    throw err
  } finally {
    await unlink(tmpPath).catch(() => {})
  }

  return parseTextLines(text)
}

export function parseTextLines(text: string): ParsedPdfBlock[] {
  const blocks: ParsedPdfBlock[] = []
  let paragraph = ''

  for (const line of text.split('\n')) {
    const trimmed = line.trim()

    if (!trimmed) {
      if (paragraph) {
        blocks.push(classifyBlock(paragraph))
        paragraph = ''
      }
      continue
    }

    // ALL-CAPS short line = heading candidate
    if (trimmed === trimmed.toUpperCase() && trimmed.length < 80 && trimmed.length > 2 && /[A-Z]/.test(trimmed)) {
      if (paragraph) { blocks.push(classifyBlock(paragraph)); paragraph = '' }
      blocks.push({ block_type: 'heading', content: trimmed, level: 1, meta: { parse_confidence: 0.75 } })
      continue
    }

    // Indented line = possible list item
    if (line.match(/^\s{4,}[-•*]/) || line.match(/^\s{2,}[0-9]+\./)) {
      if (paragraph) { blocks.push(classifyBlock(paragraph)); paragraph = '' }
      blocks.push({ block_type: 'list_item', content: trimmed, level: null, meta: { parse_confidence: 0.8 } })
      continue
    }

    paragraph += (paragraph ? ' ' : '') + trimmed
  }
  if (paragraph) blocks.push(classifyBlock(paragraph))
  return blocks
}

export function classifyBlock(text: string): ParsedPdfBlock {
  // Short lines that look like headers/footers
  if (text.length < 40 && !text.endsWith('.')) {
    return { block_type: 'paragraph', content: text, level: null, meta: { parse_confidence: 0.6 } }
  }
  // Full paragraphs with sentence-ending punctuation
  const confidence = /[.!?]$/.test(text.trim()) ? 0.9 : 0.75
  return { block_type: 'paragraph', content: text, level: null, meta: { parse_confidence: confidence } }
}
