#!/usr/bin/env bun
/**
 * Stock Rust validator. Runs `cargo check` against the merged tree in cwd.
 * Exits 0 iff the tree compiles.
 *
 * Used by fixtures that set `validator: rust` in meta.yaml. The merged
 * tree must include a Cargo.toml; fixtures supply one through their
 * base/branch_a/branch_b trees.
 */
import { spawnSync } from 'node:child_process';

const result = spawnSync('cargo', ['check', '--quiet'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR ?? './_cargo-target',
    CARGO_NET_OFFLINE: process.env.CARGO_NET_OFFLINE ?? 'false',
  },
});

process.exit(result.status ?? 1);
