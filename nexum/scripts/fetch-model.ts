#!/usr/bin/env tsx
/**
 * Issue #105: fetch and verify the pinned local CPU model.
 *
 * Reads `models/manifest.json` and downloads each file in `models[default]`
 * into the cache directory (env `NEXUM_MODEL_CACHE_DIR`, default
 * `models/cache/<huggingface_id>/`). Verifies the SHA-256 of every file
 * against the manifest and aborts on mismatch. A no-op on a warm cache.
 *
 * Usage:
 *   npx tsx scripts/fetch-model.ts             # fetch the default model
 *   npx tsx scripts/fetch-model.ts --all       # fetch every model in the manifest
 *   npx tsx scripts/fetch-model.ts --model <id># fetch a specific model id
 *
 * The script is intentionally side-effect-free on a warm cache so CI
 * workflows can `actions/cache` `models/cache/` and re-run this command on
 * every build to assert integrity. On a cold cache the download cost
 * for the pinned default (Xenova/all-MiniLM-L6-v2 ONNX int8) is ~24 MB.
 */

import { createHash } from 'node:crypto'
import { promises as fs, createWriteStream } from 'node:fs'
import * as path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
// `pipeline` is used to copy network bytes into a file with backpressure.

interface ManifestFile {
  path: string
  url: string
  sha256: string
  bytes: number
}

interface ManifestModel {
  purpose: string
  huggingface_id: string
  revision: string
  format: string
  approximate_total_bytes: number
  files: ManifestFile[]
}

interface Manifest {
  default: string
  models: Record<string, ManifestModel>
  cache_dir_env: string
  cache_dir_default: string
}

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')

async function readManifest(): Promise<Manifest> {
  const text = await fs.readFile(path.join(repoRoot, 'models', 'manifest.json'), 'utf8')
  return JSON.parse(text) as Manifest
}

function cacheRoot(manifest: Manifest): string {
  const fromEnv = process.env[manifest.cache_dir_env]
  return fromEnv ? path.resolve(fromEnv) : path.resolve(repoRoot, manifest.cache_dir_default)
}

async function sha256OfFile(file: string): Promise<string> {
  const h = createHash('sha256')
  const handle = await fs.open(file, 'r')
  try {
    const stream = handle.createReadStream()
    for await (const chunk of stream) {
      h.update(chunk as Buffer)
    }
  } finally {
    // The read stream auto-closes on end, but be explicit if it errored.
  }
  return h.digest('hex')
}

async function fileExistsWithSize(file: string, size: number): Promise<boolean> {
  try {
    const st = await fs.stat(file)
    return st.size === size
  } catch {
    return false
  }
}

async function downloadTo(url: string, dest: string): Promise<void> {
  const tmp = dest + '.partial'
  await fs.mkdir(path.dirname(dest), { recursive: true })
  const res = await fetch(url)
  if (!res.ok || !res.body) {
    throw new Error(`fetch ${url} failed: HTTP ${res.status}`)
  }
  // Node's fetch returns a web ReadableStream; convert to a Node stream.
  const nodeStream = Readable.fromWeb(res.body as any)
  await pipeline(nodeStream, createWriteStream(tmp))
  await fs.rename(tmp, dest)
}

async function fetchModel(manifest: Manifest, modelKey: string): Promise<void> {
  const model = manifest.models[modelKey]
  if (!model) {
    throw new Error(`unknown model id '${modelKey}' in models/manifest.json`)
  }
  const root = path.join(cacheRoot(manifest), model.huggingface_id)
  console.log(`[fetch-model] target: ${model.huggingface_id} -> ${root}`)
  for (const f of model.files) {
    const dest = path.join(root, f.path)
    if (await fileExistsWithSize(dest, f.bytes)) {
      const got = await sha256OfFile(dest)
      if (got === f.sha256) {
        console.log(`[fetch-model]   ok (cached) ${f.path}`)
        continue
      }
      console.log(`[fetch-model]   stale (sha mismatch) ${f.path} — re-downloading`)
      await fs.rm(dest, { force: true })
    }
    console.log(`[fetch-model]   downloading ${f.path} (~${(f.bytes / 1024 / 1024).toFixed(1)} MB)`)
    await downloadTo(f.url, dest)
    const got = await sha256OfFile(dest)
    if (got !== f.sha256) {
      throw new Error(
        `sha256 mismatch for ${f.path}: expected ${f.sha256}, got ${got}. ` +
          `Aborting; the manifest pin and the upstream HuggingFace blob disagree.`,
      )
    }
    console.log(`[fetch-model]   verified ${f.path}`)
  }
}

async function main(): Promise<void> {
  const manifest = await readManifest()
  const args = process.argv.slice(2)
  let toFetch: string[]
  if (args.includes('--all')) {
    toFetch = Object.keys(manifest.models)
  } else {
    const idx = args.indexOf('--model')
    toFetch = [idx >= 0 ? args[idx + 1] : manifest.default]
  }
  for (const m of toFetch) await fetchModel(manifest, m)
  console.log(`[fetch-model] all done.`)
}

main().catch((err) => {
  console.error('[fetch-model] FAIL:', err.message ?? err)
  process.exit(1)
})
