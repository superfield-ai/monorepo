import { claimJob, completeJob, failJob, enqueueJob } from '../db/jobs.js'
import { query, execute } from '../db/queries.js'
import { randomUUID } from 'node:crypto'
import { embedEdge } from './edge-embed.js'
import { writeAgeEdge } from '../db/age.js'
import { timeStage } from '../ingest/timing.js'

const CITATION_PATTERNS = [
  { regex: /§\s*(\d+[\.\d]*)/g,          type: 'section' },
  { regex: /¶\s*(\d+)/g,                 type: 'paragraph' },
  { regex: /[Ss]ection\s+(\d+[\.\d]*)/g, type: 'section' },
  { regex: /[Ee]xhibit\s+([A-Z])/g,      type: 'exhibit' },
  { regex: /[Ss]chedule\s+(\d+)/g,       type: 'schedule' },
]

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

export function extractCitationRefs(content: string): string[] {
  const refs: string[] = []
  for (const { regex, type } of CITATION_PATTERNS) {
    const pattern = new RegExp(regex.source, regex.flags)
    let match: RegExpExecArray | null
    while ((match = pattern.exec(content)) !== null) {
      refs.push(`${type}:${match[1]}`)
    }
  }
  return [...new Set(refs)]
}

export async function processStructuralLinks(versionId: string): Promise<void> {
  // Get all blocks for this version with their doc_id
  const blocks = await query<{ id: string; content: string; doc_id: string }>(
    `SELECT b.id, b.content, b.doc_id
     FROM blocks b JOIN version_blocks vb ON vb.block_id = b.id
     WHERE vb.version_id = $1`,
    [versionId]
  )

  for (const block of blocks) {
    const refs = extractCitationRefs(block.content)
    if (refs.length === 0) continue

    for (const ref of refs) {
      const [refType, refValue] = ref.split(':')

      // Search same document's blocks for the referenced section
      let searchPattern: string
      if (refType === 'section') searchPattern = `%${refValue}%`
      else if (refType === 'exhibit') searchPattern = `%Exhibit ${refValue}%`
      else if (refType === 'schedule') searchPattern = `%Schedule ${refValue}%`
      else searchPattern = `%${refValue}%`

      const targets = await query<{ id: string; content: string }>(
        `SELECT b.id, b.content FROM blocks b
         JOIN version_blocks vb ON vb.block_id = b.id
         WHERE vb.version_id = $1
           AND b.id != $2
           AND b.content ILIKE $3`,
        [versionId, block.id, searchPattern]
      )

      for (const target of targets) {
        if (target.id === block.id) continue // skip self-references

        // Edge embedding for the citation edge (issue #75, phase-2).
        const edgeVec = await timeStage('edge_embed', { docId: block.doc_id, blockCount: 1 }, () =>
          embedEdge(block.content, target.content, 'cites'),
        )

        await execute(
          `INSERT INTO links (id, src, dst, layer, rel_type, weight, confirmed, provenance, edge_embedding)
           VALUES ($1, $2, $3, 'structural', 'cites', 1.0, null, $4, ${edgeVec ? '$5::vector' : 'NULL'})
           ON CONFLICT DO NOTHING`,
          edgeVec
            ? [
                randomUUID(), block.id, target.id,
                JSON.stringify({ model: 'regex', confidence: 1.0, created_at: new Date().toISOString() }),
                edgeVec,
              ]
            : [
                randomUUID(), block.id, target.id,
                JSON.stringify({ model: 'regex', confidence: 1.0, created_at: new Date().toISOString() }),
              ],
        )

        await writeAgeEdge({ src: block.id, dst: target.id, layer: 'structural', relType: 'cites', weight: 1.0 })
      }
    }
  }

  // Update version status
  await execute(
    `UPDATE document_versions SET status = 'done' WHERE id = $1`,
    [versionId]
  )
  // Enqueue AI linker
  await enqueueJob('ai-link', { version_id: versionId })
}

export async function runStructuralLinker(signal?: AbortSignal) {
  while (!signal?.aborted) {
    const job = await claimJob('structural-link')
    if (!job) { await sleep(2000); continue }

    try {
      await processStructuralLinks((job.payload as any).version_id)
      await completeJob(job.id)
    } catch (err) {
      console.error('structural linker error', err)
      await failJob(job.id)
    }
  }
}
