#!/usr/bin/env node
/**
 * Phase-2/3 dev-scout (issues #79, #107): CI lint enforcing the inference-client seam.
 *
 * Two checks run in sequence:
 *
 * CHECK 1 — experiment-area seam (unchanged from issue #79):
 *   Phase-2 experiment directories that touch inference (Area 2 curriculum,
 *   Area 3 retrieval-augmented inference, Area 6 GPU acceleration, Area 7
 *   differentiable graph) MUST go through `src/inference/client.ts`. Any
 *   TypeScript file in those dirs that calls embed/retrieve/score without
 *   importing from the shared interface fails CI.
 *
 * CHECK 2 — src/ SDK-import seam (issue #107):
 *   Architecture A3 makes InferenceClient the only sanctioned seam for
 *   LLM-class calls. Any TypeScript file under `src/` that imports
 *   `@anthropic-ai/sdk`, `openai`, or similar hosted-provider SDKs MUST
 *   live under `src/inference/adapters/`. Files elsewhere that import those
 *   SDKs directly bypass InferenceClient and fail CI.
 *
 * Canonical references:
 *   - docs/architecture.md § A3 (InferenceClient seam)
 *   - docs/engineering.md (Phase-2 Scout Seams → CI lint)
 *   - src/inference/client.ts (the interface this lint protects)
 *   - src/inference/adapters/ (the only allowed SDK import site)
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// NEXUM_LINT_REPO_ROOT is an escape hatch for unit tests that need to run the
// lint against a fixture tree rather than the real repository root.
const repoRoot = process.env.NEXUM_LINT_REPO_ROOT ?? path.resolve(__dirname, '..')

// ---------------------------------------------------------------------------
// CHECK 1: Experiment-area inference-call seam
// ---------------------------------------------------------------------------

// Experiment directories whose TypeScript entries are required to consume
// the shared inference-client interface.
const PHASE2_AREAS = [
  'experiments/area2-training-curriculum',
  'experiments/area3-retrieval-inference',
  'experiments/area6-gpu-acceleration',
  'experiments/area7-differentiable-graph',
]

// A file "looks like" it does inference work if it references one of these
// identifiers as a function call. The list is deliberately small; expand
// it if a downstream issue introduces a new inference verb.
const INFERENCE_CALL_PATTERN =
  /\b(?:embed|retrieve|score)\s*\(/

// Files that import from the shared interface satisfy the lint regardless
// of which verbs they call.
const REQUIRED_IMPORT_PATTERN =
  /from\s+['"][^'"]*src\/inference\/client(?:\.js)?['"]/

// ---------------------------------------------------------------------------
// CHECK 2: src/ SDK-import seam (issue #107)
// ---------------------------------------------------------------------------

// Hosted-provider SDK package names that are only allowed inside the
// adapters directory. Expand this list if a new SDK is introduced.
const FORBIDDEN_SDK_PATTERNS = [
  /@anthropic-ai\/sdk/,
  /^openai$/,
  /^openai\//,
]

// The one directory under src/ where SDK imports are sanctioned.
const ADAPTERS_DIR = path.join(repoRoot, 'src', 'inference', 'adapters')

/**
 * Return true if the file content contains a direct import of a forbidden SDK.
 * Matches both `import ... from 'pkg'` and `require('pkg')` forms.
 */
function importsForbiddenSdk(text) {
  // Extract all import/require specifiers.
  const specifierRe =
    /(?:from|import)\s+['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  let m
  while ((m = specifierRe.exec(text)) !== null) {
    const spec = m[1] ?? m[2]
    if (FORBIDDEN_SDK_PATTERNS.some((p) => p.test(spec))) return true
  }
  return false
}

/** Recursively yield every .ts file under `dir` (skips node_modules/dist). */
async function* walkTs(dir) {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch (err) {
    if (err.code === 'ENOENT') return
    throw err
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue
      yield* walkTs(full)
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      yield full
    }
  }
}

// ---------------------------------------------------------------------------
// Run CHECK 1
// ---------------------------------------------------------------------------

const check1Violations = []

for (const area of PHASE2_AREAS) {
  const abs = path.join(repoRoot, area)
  for await (const file of walkTs(abs)) {
    const text = await fs.readFile(file, 'utf8')
    if (!INFERENCE_CALL_PATTERN.test(text)) continue
    if (REQUIRED_IMPORT_PATTERN.test(text)) continue
    check1Violations.push(path.relative(repoRoot, file))
  }
}

if (check1Violations.length > 0) {
  console.error(
    'phase-2 inference-client lint failed; the following files call ' +
      'embed/retrieve/score but do not import from src/inference/client.ts:',
  )
  for (const v of check1Violations) console.error('  - ' + v)
  console.error(
    '\nFix: import { InferenceClient } from "<rel>/src/inference/client.js" ' +
      'and route the call through it. See docs/engineering.md → ' +
      '"Phase-2 Scout Seams".',
  )
  process.exit(1)
}

console.log(
  'phase-2 inference-client lint OK (' +
    PHASE2_AREAS.length +
    ' area dirs scanned, no violations).',
)

// ---------------------------------------------------------------------------
// Run CHECK 2: scan all of src/ for direct SDK imports
// ---------------------------------------------------------------------------

const check2Violations = []
const srcDir = path.join(repoRoot, 'src')

for await (const file of walkTs(srcDir)) {
  // src/inference/adapters/ is the sanctioned seam — skip it.
  if (file.startsWith(ADAPTERS_DIR + path.sep) || file === ADAPTERS_DIR) continue

  const text = await fs.readFile(file, 'utf8')
  if (!importsForbiddenSdk(text)) continue
  check2Violations.push(path.relative(repoRoot, file))
}

if (check2Violations.length > 0) {
  console.error(
    '\nphase-3 inference-client seam lint failed; the following files under src/ ' +
      'import a hosted-provider SDK (@anthropic-ai/sdk, openai, …) directly:',
  )
  for (const v of check2Violations) console.error('  - ' + v)
  console.error(
    '\nAll LLM-class calls MUST go through InferenceClient ' +
      '(src/inference/client.ts). Hosted-provider SDK imports are only ' +
      'allowed inside src/inference/adapters/. ' +
      'See docs/architecture.md § A3.',
  )
  process.exit(1)
}

console.log(
  'phase-3 src/ SDK-import seam lint OK ' +
    '(src/ scanned, no direct hosted-provider SDK imports outside adapters/).',
)
