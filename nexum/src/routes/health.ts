import { route, send } from '../server.js'

route('GET', '/health', async (_req, res) => {
  try {
    // Import lazily to avoid circular deps at startup
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — queries module added in issue #37
    const { query } = await import('../db/queries.js')
    await query('SELECT 1')
    send(res, 200, { status: 'ok', db: 'connected', uptime_sec: Math.floor(process.uptime()) })
  } catch {
    send(res, 503, { status: 'error', db: 'unreachable' })
  }
})
