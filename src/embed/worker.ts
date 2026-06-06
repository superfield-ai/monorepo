import { claimJob, completeJob, failJob, enqueueJob } from '../db/jobs.js'
import { query, execute } from '../db/queries.js'
import { embedTexts } from './local.js'

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

export async function runEmbedWorker(signal?: AbortSignal) {
  while (!signal?.aborted) {
    const job = await claimJob('embed-version')
    if (!job) { await sleep(1000); continue }

    try {
      const versionId = (job.payload as any).version_id as string
      const blocks = await query<{ id: string; content: string }>(
        `SELECT b.id, b.content
         FROM blocks b
         JOIN version_blocks vb ON vb.block_id = b.id
         WHERE vb.version_id = $1 AND b.embedding IS NULL`,
        [versionId]
      )

      for (const batch of chunk(blocks, 64)) {
        const vecs = await embedTexts(batch.map(b => b.content))
        for (let i = 0; i < batch.length; i++) {
          await execute(
            `UPDATE blocks SET embedding = $1 WHERE id = $2`,
            [`[${vecs[i].join(',')}]`, batch[i].id]
          )
        }
      }

      await execute(
        `UPDATE document_versions SET status = 'embedded' WHERE id = $1`,
        [versionId]
      )
      await completeJob(job.id)
      await enqueueJob('structural-link', { version_id: versionId })
    } catch (err) {
      console.error('embed worker error', err)
      await failJob(job.id)
    }
  }
}
