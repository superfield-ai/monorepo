import { route, send } from '../server.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const specPath = join(dirname(fileURLToPath(import.meta.url)), '../../openapi.json')
let spec: unknown
try { spec = JSON.parse(readFileSync(specPath, 'utf-8')) } catch { spec = { error: 'spec not found' } }

route('GET', '/openapi.json', async (_req, res) => {
  send(res, 200, spec)
})
