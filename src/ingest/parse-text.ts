export interface ParsedBlock {
  block_type: 'paragraph' | 'heading' | 'list_item'
  content: string
  level: number | null
}

export function parseText(content: string): ParsedBlock[] {
  return content
    .split(/\n\n+/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => ({ block_type: 'paragraph', content: s, level: null }))
}
