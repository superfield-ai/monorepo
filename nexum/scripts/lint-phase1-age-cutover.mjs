#!/usr/bin/env node
/**
 * Phase-1 AGE-default cutover (issue #99): CI lint enforcing the cutover.
 *
 * After the cutover the runtime code in `src/db/age.ts` no longer carries a
 * soft-fail / optional-companion fallback, and `docker-compose.yml` runs
 * exactly one Postgres service on `apache/age:PG16_latest`. This lint asserts
 * both invariants so a future refactor cannot silently re-introduce the
 * dual-mode posture that phase-1 retired.
 *
 * Specifically the lint checks:
 *  1. `src/db/age.ts` does not use the words `mode: 'optional'` or
 *     `mode: 'unavailable'` (the old StartupRequireAgeResult modes).
 *  2. `src/db/age.ts` does not log `console.warn(...)` from
 *     `startupRequireAge` (the old soft-fail branch).
 *  3. `docker-compose.yml` does not reference `pgvector/pgvector:pg16`
 *     (the old non-AGE Postgres image) or `postgres-age:` (the old second
 *     companion service).
 *
 * Canonical references:
 *   - docs/engineering.md (Phase-1 AGE-default cutover seams)
 *   - src/db/age.ts (the runtime hard gate)
 *   - docker-compose.yml (the only supported Postgres image)
 */

import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

const failures = []

function read(rel) {
  return readFileSync(path.join(repoRoot, rel), 'utf-8')
}

const ageSrc = read('src/db/age.ts')
if (/mode:\s*['"]optional['"]/.test(ageSrc)) {
  failures.push("src/db/age.ts still references the retired StartupRequireAgeResult mode 'optional'")
}
if (/mode:\s*['"]unavailable['"]/.test(ageSrc)) {
  failures.push("src/db/age.ts still references the retired StartupRequireAgeResult mode 'unavailable'")
}

// startupRequireAge() must not warn-and-continue. Scan the function body for
// console.warn between the function signature and its closing brace.
const fnMatch = ageSrc.match(/export async function startupRequireAge[\s\S]*?\n\}\s*\n/)
if (!fnMatch) {
  failures.push('could not locate startupRequireAge() in src/db/age.ts')
} else if (/console\.warn/.test(fnMatch[0])) {
  failures.push('startupRequireAge() in src/db/age.ts still calls console.warn (soft-fail branch must throw)')
}

const compose = read('docker-compose.yml')
if (/pgvector\/pgvector/.test(compose)) {
  failures.push("docker-compose.yml still uses pgvector/pgvector image; phase-1 requires apache/age:PG16_latest as the only Postgres image")
}
if (/^\s*postgres-age:/m.test(compose)) {
  failures.push("docker-compose.yml still defines a second `postgres-age` service; phase-1 collapses to a single Postgres+AGE service")
}
const ageImageCount = (compose.match(/apache\/age:PG16_latest/g) || []).length
if (ageImageCount === 0) {
  failures.push('docker-compose.yml must reference apache/age:PG16_latest as the Postgres image')
}

if (failures.length > 0) {
  for (const f of failures) console.error('lint-phase1-age-cutover:', f)
  process.exit(1)
}

console.log('lint-phase1-age-cutover: ok')
