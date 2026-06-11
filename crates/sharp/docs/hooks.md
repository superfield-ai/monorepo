# Sharp Hooks

Reference for the Sharp hooks system (whitepaper §6.3, engineering-plan §7a).

Sharp's merge engine is intrinsic-only: it uses Tree-sitter ASTs and symbol-table analysis and does not shell out to language toolchains. Toolchain-specific checks — `tsc --noEmit`, `cargo check`, linters, project tests — are layered on through hooks. This keeps the merge contract portable across languages and toolchains while making the operationally common practice ("don't merge anything that doesn't compile") trivial to opt into.

---

## Events

| Event         | When it fires                                                               | Veto? |
| ------------- | --------------------------------------------------------------------------- | ----- |
| `pre-commit`  | After staging is finalized, before the commit object is created             | Yes   |
| `post-commit` | After the commit has been created and the ref advanced                      | No    |
| `pre-merge`   | For each Tier 1 candidate that passes intrinsic verification, before Tier 2 | Yes   |
| `post-merge`  | After a successful merge and ref advance                                    | No    |
| `pre-push`    | Before the client sends a ref update to the server                          | Yes   |
| `pre-receive` | Server-side, before accepting a pushed ref update                           | Yes   |

A **veto** means that a non-zero exit code from the hook drops the candidate (for `pre-merge`) or aborts the operation (for `pre-commit`, `pre-push`, `pre-receive`). Non-veto events receive the hook's stdout/stderr in the log but cannot stop the operation.

---

## Location

Per-workspace hooks live in `.sharp/hooks/<event>/`. Any executable file in that directory is run as a hook for that event. Multiple hooks per event are supported and are executed in lexicographic order by filename.

```
my-repo/
└── .sharp/
    └── hooks/
        ├── pre-commit/
        │   └── 01-lint.ts
        ├── pre-merge/
        │   ├── 10-tsc-noemit.ts -> ../../../../examples/hooks/tsc-noemit.ts
        │   └── 20-cargo-check.ts -> ../../../../examples/hooks/cargo-check.ts
        └── pre-push/
            └── 01-guard.ts
```

Server-side hooks (for `pre-receive`) are registered in the server's `repo_hooks` table via the operator CLI. Client-side hooks in `.sharp/hooks/` do not run on the server.

Stock example hooks ship under `examples/hooks/`. The recommended practice is to symlink them into your `.sharp/hooks/<event>/` directory rather than copy them, so you pick up updates automatically.

---

## Payload (stdin)

Each hook receives a JSON object on stdin describing the event context. The exact shape depends on the event:

**`pre-commit` and `pre-push`**

```json
{
  "event": "pre-commit",
  "repo": "my-project",
  "paths_changed": ["src/api.ts", "src/utils.ts"],
  "ref": "refs/heads/feature/x"
}
```

**`pre-merge`**

```json
{
  "event": "pre-merge",
  "repo": "my-project",
  "candidate_id": "candidate_1",
  "parent_commits": ["<base-sha>", "<branch-a-sha>", "<branch-b-sha>"],
  "paths_changed": ["src/api.ts"]
}
```

For `pre-merge`, the hook's current working directory is set to the **workspace path of the candidate merged tree** on disk. This means a hook can run `tsc --noEmit` or `cargo check` directly without needing to locate the tree from the JSON payload.

**`pre-receive`** (server-side)

```json
{
  "event": "pre-receive",
  "repo": "my-project",
  "ref": "refs/heads/main",
  "old_sha": "<old>",
  "new_sha": "<new>"
}
```

---

## Exit Codes

| Exit code | Meaning                                                                      |
| --------- | ---------------------------------------------------------------------------- |
| `0`       | Hook passed; proceed                                                         |
| Non-zero  | Veto (for veto-capable events) or error recorded in log (for post-\* events) |

Stdout and stderr are captured in full and:

- Included in the structured dilemma payload (`.sharp/MERGE_DILEMMA.json`) when a `pre-merge` hook vetoes a candidate.
- Written to stderr of the `sharp commit` / `sharp push` invocation when a `pre-commit` / `pre-push` hook vetoes.
- Surfaced in the server log for `pre-receive` vetoes.

---

## Timeout

Each hook is given `SHARP_HOOK_TIMEOUT_MS` milliseconds (default 60 000 ms) to complete. A hook that exceeds the timeout is killed and treated as a non-zero exit.

For slow toolchains (cold `cargo check` on a large workspace, for example) increase `SHARP_HOOK_TIMEOUT_MS` in the server's environment or in the client environment before running `sharp merge`.

---

## Example Hooks

### TypeScript type-check: `examples/hooks/tsc-noemit.ts`

Runs `tsc --noEmit` against the candidate merged tree. If the tree does not typecheck, the hook exits non-zero and the candidate is dropped. Install as a `pre-merge` hook to ensure no merge Sharp produces fails to compile.

```bash
cd my-repo
chmod +x examples/hooks/tsc-noemit.ts
ln -s ../../../../examples/hooks/tsc-noemit.ts .sharp/hooks/pre-merge/10-tsc-noemit.ts
```

The hook writes a minimal `tsconfig.json` if none is present (useful for fixture trees in CI). In real projects it uses the project's own `tsconfig.json`.

### Rust compile-check: `examples/hooks/cargo-check.ts`

Runs `cargo check --quiet` against the candidate merged tree. Uses `CARGO_TARGET_DIR` from the environment (defaulting to `./_cargo-target`) so each candidate's build artifacts do not collide with the project's normal build directory.

```bash
cd my-repo
chmod +x examples/hooks/cargo-check.ts
ln -s ../../../../examples/hooks/cargo-check.ts .sharp/hooks/pre-merge/20-cargo-check.ts
```

---

## Security Notes

Hooks are executables that run with the **full developer environment**. They inherit:

- `HOME` and all user-level config files
- `RUSTUP_HOME`, `CARGO_HOME`, `GOPATH`, and other toolchain paths
- Any secrets present in environment variables at the time `sharp merge` or `sharp commit` is invoked
- The current user's filesystem access

This is the same threat model as Git hooks. Implications:

- **Do not install hooks from untrusted sources.** A malicious hook can read secrets, write to the filesystem, or make network calls.
- **Server-side `pre-receive` hooks run as the server process user.** Ensure the server process has only the permissions it needs; do not run it as root.
- **Hooks in `.sharp/hooks/` are not committed to the repository by default.** Unlike source files, hooks are part of the local workspace configuration. If you want hooks to be shared across a team, check them into the repository under a conventional path (e.g., `tools/hooks/`) and document the symlink setup step, or use a `post-clone` script.
- **Environment isolation.** The test harness's lane runners pin hook environments to avoid developer-config bleed-through in CI. For production use, consider wrapping hooks with an explicit `env -i` invocation to control exactly which environment variables are visible.
