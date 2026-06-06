import type { ParsedBlock } from './parse-text.js'

export function parseMarkdown(content: string): ParsedBlock[] {
  const blocks: ParsedBlock[] = []
  let buf = ''
  let blockType: ParsedBlock['block_type'] = 'paragraph'
  let level: number | null = null

  function flush() {
    const text = buf.trim()
    if (text) blocks.push({ block_type: blockType, content: text, level })
    buf = ''; blockType = 'paragraph'; level = null
  }

  for (const line of content.split('\n')) {
    const heading = line.match(/^(#{1,6})\s+(.+)/)
    if (heading) {
      flush()
      blockType = 'heading'; level = heading[1].length; buf = heading[2]
      flush()
    } else if (line.match(/^[-*]\s+/)) {
      flush()
      blockType = 'list_item'; buf = line.replace(/^[-*]\s+/, '')
      flush()
    } else if (line.trim() === '') {
      flush()
    } else {
      buf += (buf ? '\n' : '') + line
    }
  }
  flush()
  return blocks
}
