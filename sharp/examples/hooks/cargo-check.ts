#!/usr/bin/env bun
/**
 * Stock pre-merge hook: run `cargo check` against the merged tree.
 *
 * Drop a symlink at `.sharp/hooks/pre-merge/cargo-check.ts` and
 * `chmod +x`. Sharp's merge engine drops candidates where this hook
 * exits non-zero.
 */
import { spawnSync } from 'node:child_process';

const r = spawnSync('cargo', ['check', '--quiet'], {
  stdio: 'inherit',
  env: { ...process.env, CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR ?? './_cargo-target' },
});
process.exit(r.status ?? 1);
