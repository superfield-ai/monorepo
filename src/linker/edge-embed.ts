/**
 * Edge-embedding construction (issue #75, phase-2).
 *
 * Strategy (b) from the issue: embed a templated string of the form
 *
 *     "<rel_type>: <src_snippet> -> <dst_snippet>"
 *
 * with the same all-MiniLM-L6-v2 model used for blocks, so the resulting
 * vector lives in the same 384-D space and can be retrieved with the same
 * pgvector cosine operator. Strategy (a) (concat / avg of endpoint vectors)
 * is intentionally NOT chosen here — it cannot represent rel_type, which is
 * what makes edge-similarity search semantically distinct from block search.
 *
 * The snippets are truncated to keep the prompt short (the embedder will
 * silently truncate at 256 tokens anyway; we cap earlier to keep the
 * latency floor predictable across edge-count scale).
 */

import { embedTexts } from '../embed/local.js'

const SNIPPET_CHARS = 240

export function buildEdgeText(srcContent: string, dstContent: string, relType: string | null): string {
  const rel = relType ?? 'related'
  const src = srcContent.slice(0, SNIPPET_CHARS).replace(/\s+/g, ' ').trim()
  const dst = dstContent.slice(0, SNIPPET_CHARS).replace(/\s+/g, ' ').trim()
  return `${rel}: ${src} -> ${dst}`
}

/** Returns a pgvector literal `[v1,v2,...]` for direct interpolation. */
export function vectorLiteral(vec: number[]): string {
  return `[${vec.join(',')}]`
}

/**
 * Embed one edge. Returns the pgvector literal string, or null when the
 * embedder yields no vector (which should not happen in practice).
 */
export async function embedEdge(
  srcContent: string,
  dstContent: string,
  relType: string | null,
): Promise<string | null> {
  const text = buildEdgeText(srcContent, dstContent, relType)
  const [vec] = await embedTexts([text])
  if (!vec) return null
  return vectorLiteral(vec)
}
