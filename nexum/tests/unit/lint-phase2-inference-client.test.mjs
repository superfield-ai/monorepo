/**
 * Unit tests for scripts/lint-phase2-inference-client.mjs — CHECK 2
 * (issue #107): src/ SDK-import seam.
 *
 * We spawn the lint script with NEXUM_LINT_REPO_ROOT pointing to a temp
 * directory that we control, so we can place fixture files in src/ and
 * src/inference/adapters/ without touching the real repository tree.
 *
 * CHECK 1 (experiment-area inference-call seam) is tested implicitly: the
 * four PHASE2_AREAS directories don't exist in the temp tree, so walkTs
 * handles them via ENOENT and CHECK 1 is effectively a no-op.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import * as os from 'node:os'

const execFileAsync = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '../..')
const lintScript = path.join(repoRoot, 'scripts', 'lint-phase2-inference-client.mjs')

/**
 * Create a minimal temp repo layout with the given src/ files, run the lint
 * script inside it via NEXUM_LINT_REPO_ROOT, and return { exitCode, stdout, stderr }.
 *
 * @param {Record<string,string>} srcFiles - map of relative-path-in-tmpdir → content
 */
async function runLintInTemp(srcFiles) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexum-lint-test-'))
  try {
    for (const [rel, content] of Object.entries(srcFiles)) {
      const abs = path.join(tmpDir, rel)
      await fs.mkdir(path.dirname(abs), { recursive: true })
      await fs.writeFile(abs, content, 'utf8')
    }

    const result = await execFileAsync('node', [lintScript], {
      cwd: tmpDir,
      env: { ...process.env, NEXUM_LINT_REPO_ROOT: tmpDir },
    }).then(
      ({ stdout, stderr }) => ({ exitCode: 0, stdout, stderr }),
      (err) => ({ exitCode: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' }),
    )
    return result
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('lint flags a src/ file that imports @anthropic-ai/sdk directly', async () => {
  const result = await runLintInTemp({
    'src/routes/bad-route.ts': `
import Anthropic from '@anthropic-ai/sdk'
export async function doSomething() {
  const c = new Anthropic()
  return c
}
`,
  })
  assert.notEqual(result.exitCode, 0, `expected non-zero exit code for violation\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)
  assert.match(
    result.stderr,
    /InferenceClient/,
    'error message should reference InferenceClient',
  )
})

test('lint flags a src/ file that imports openai directly', async () => {
  const result = await runLintInTemp({
    'src/routes/bad-openai.ts': `
import OpenAI from 'openai'
export async function doSomething() {
  const c = new OpenAI()
  return c
}
`,
  })
  assert.notEqual(result.exitCode, 0, `expected non-zero exit code for violation\nstdout: ${result.stdout}\nstderr: ${result.stderr}`)
  assert.match(result.stderr, /InferenceClient/)
})

test('lint allows SDK imports under src/inference/adapters/', async () => {
  const result = await runLintInTemp({
    'src/inference/adapters/my-adapter.ts': `
import Anthropic from '@anthropic-ai/sdk'
export class MyAdapter { private c = new Anthropic() }
`,
  })
  assert.equal(
    result.exitCode,
    0,
    `expected exit 0 but got ${result.exitCode}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  )
})

test('lint passes when src/ has no forbidden SDK imports', async () => {
  const result = await runLintInTemp({
    'src/routes/good-route.ts': `
import { getDefaultInferenceClient } from '../inference/index.js'
export async function goodRoute() {
  const client = getDefaultInferenceClient()
  return client.embed('hello')
}
`,
  })
  assert.equal(
    result.exitCode,
    0,
    `expected exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  )
})

test('lint error message references InferenceClient as the required seam', async () => {
  const result = await runLintInTemp({
    'src/workers/direct-call.ts': `
import Anthropic from '@anthropic-ai/sdk'
export async function work() { return new Anthropic() }
`,
  })
  assert.notEqual(result.exitCode, 0)
  assert.match(result.stderr, /InferenceClient/, 'error must name InferenceClient')
  assert.match(result.stderr, /src\/inference\/adapters/, 'error must point to adapters dir')
})

test('lint allows a clean src/ tree with no sdk imports at all', async () => {
  const result = await runLintInTemp({
    'src/db/query.ts': `
export function buildQuery(sql: string) { return sql }
`,
    'src/routes/health.ts': `
export function health() { return { ok: true } }
`,
  })
  assert.equal(
    result.exitCode,
    0,
    `expected exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  )
})
