import { query, execute } from './queries.js'
import { randomUUID } from 'node:crypto'

export interface Job {
  id: string
  job_type: string
  payload: Record<string, unknown>
}

export async function enqueueJob(jobType: string, payload: Record<string, unknown>): Promise<void> {
  await execute(
    `INSERT INTO job_queue (id, job_type, payload) VALUES ($1, $2, $3)`,
    [randomUUID(), jobType, JSON.stringify(payload)]
  )
}

export async function claimJob(jobType: string): Promise<Job | null> {
  const rows = await query<Job>(
    `UPDATE job_queue SET status = 'running', attempts = attempts + 1
     WHERE id = (
       SELECT id FROM job_queue
       WHERE job_type = $1 AND status = 'pending'
       ORDER BY created_at
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, job_type, payload`,
    [jobType]
  )
  return rows[0] ?? null
}

export async function completeJob(id: string): Promise<void> {
  await execute(`UPDATE job_queue SET status = 'done' WHERE id = $1`, [id])
}

export async function failJob(id: string): Promise<void> {
  await execute(`UPDATE job_queue SET status = 'failed' WHERE id = $1`, [id])
}
