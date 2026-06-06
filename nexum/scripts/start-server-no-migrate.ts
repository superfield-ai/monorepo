// Worktree-local helper for the G2 wedge demo: starts Nexum API without running
// the JS-side migration. Schema must already be loaded into the target database
// (apply db/schema.sql via psql first). Used by experiments/g2-wedge-demo when
// the migrate.ts splitStatements helper trips on the schema's trailing edge.
import { createApp } from '../src/server.js'
import '../src/routes/health.js'
import '../src/routes/corpora.js'
import '../src/routes/documents.js'
import '../src/routes/entities.js'
import '../src/routes/embed.js'
import '../src/routes/query.js'
import '../src/routes/openapi.js'

const PORT = parseInt(process.env.PORT ?? '3010')
createApp().listen(PORT, () => console.log(`Nexum (no-migrate) ready on ${PORT}`))
