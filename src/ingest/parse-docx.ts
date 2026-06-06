import mammoth from 'mammoth'
import type { ParsedBlock } from './parse-text.js'

export async function parseDocx(docxBuffer: Buffer): Promise<ParsedBlock[]> {
  const result = await mammoth.convertToHtml(
    { buffer: docxBuffer },
    {
      styleMap: [
        "p[style-name='Heading 1'] => h1:fresh",
        "p[style-name='Heading 2'] => h2:fresh",
        "p[style-name='Heading 3'] => h3:fresh",
        "p[style-name='Heading 4'] => h4:fresh",
        "p[style-name='Heading 5'] => h5:fresh",
        "p[style-name='Heading 6'] => h6:fresh",
      ]
    }
  )
  return parseHtml(result.value)
}

export function parseHtml(html: string): ParsedBlock[] {
  const blocks: ParsedBlock[] = []
  // Simple regex-based HTML parser — no DOM dependency
  const tagPattern = /<(h[1-6]|p|li|ul|ol)[^>]*>(.*?)<\/\1>/gis
  let match: RegExpExecArray | null

  while ((match = tagPattern.exec(html)) !== null) {
    const tag = match[1].toLowerCase()
    const rawContent = match[2]

    if (tag === 'ul' || tag === 'ol') {
      // Extract list items from within list containers
      const liPattern = /<li[^>]*>(.*?)<\/li>/gis
      let liMatch: RegExpExecArray | null
      while ((liMatch = liPattern.exec(rawContent)) !== null) {
        const content = liMatch[1].replace(/<[^>]+>/g, '').trim()
        if (content) blocks.push({ block_type: 'list_item', content, level: null })
      }
      continue
    }

    const content = rawContent.replace(/<[^>]+>/g, '').trim() // strip inner tags

    if (!content) continue

    if (tag.match(/^h([1-6])$/)) {
      const level = parseInt(tag[1])
      blocks.push({ block_type: 'heading', content, level })
    } else if (tag === 'li') {
      blocks.push({ block_type: 'list_item', content, level: null })
    } else if (tag === 'p') {
      blocks.push({ block_type: 'paragraph', content, level: null })
    }
  }
  return blocks
}
