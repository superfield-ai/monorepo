import { config } from './config.js'
import { migrate } from './db/migrate.js'
import { startupRequireAge } from './db/age.js'
import { createApp } from './server.js'
import { runEmbedWorker } from './embed/worker.js'
import { runStructuralLinker } from './linker/structural.js'
import { runAiLinker } from './linker/ai.js'
import './routes/health.js'
import './routes/corpora.js'
import './routes/documents.js'
import './routes/entities.js'
import './routes/embed.js'
import './routes/query.js'
import './routes/synthesize.js' // Phase-4 synthesis write-back stubs (issue #115 dev-scout)
import './routes/blocks.js'    // Phase-4 GET /blocks polling cursor (issue #111)
import './routes/openapi.js'

await migrate()

// Phase-1 AGE-default cutover (issues #98 scout, #99 hardening). Hard gate:
// throws when the configured Postgres lacks the AGE extension, refusing to
// serve traffic against a database that cannot answer graph queries.
await startupRequireAge()

// Start background workers AFTER AGE is verified so graph writes succeed.
// Each worker polls its job_queue type in a tight loop; the AbortSignal allows
// clean shutdown (issue #134 wiring fix).
const workerAbort = new AbortController()
runEmbedWorker(workerAbort.signal).catch(err => console.error('embed worker fatal', err))
runStructuralLinker(workerAbort.signal).catch(err => console.error('structural linker fatal', err))
runAiLinker(workerAbort.signal).catch(err => console.error('ai linker fatal', err))

const server = createApp()
server.listen(config.PORT, () => {
  console.log(`Nexum API ready — http://localhost:${config.PORT} — GET /openapi.json for API docs`)
})
