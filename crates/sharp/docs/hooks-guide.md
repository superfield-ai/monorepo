# Sharp Hooks — Practical Guide

A task-oriented companion to [`hooks.md`](./hooks.md). Where `hooks.md` is the
reference (event table, payload shapes, exit codes), this guide walks through
installing real hooks, what actually runs today, and how to debug a hook that
vetoes a merge.

All claims below are grounded in the canonical Rust crate
(`crates/sharp/src/hooks.rs`, `crates/sharp/src/tier1.rs`). Where the Rust
implementation differs from the older TypeScript prototype or from `hooks.md`,
that is called out explicitly.

---

## 1. Problem statement

Sharp's merge engine is **intrinsic-only**: it reasons about merges using
Tree-sitter ASTs and symbol tables, and never shells out to a language
toolchain to decide a merge. That keeps the merge contract portable, but it
means Sharp by itself will happily produce a merged tree that does not compile
or lint. Hooks are the escape hatch: drop an executable into your workspace and
Sharp runs it against the candidate merged tree, vetoing the merge if it fails.

> Note: Rust merges have a _separate_, built-in `cargo check` gate
> (`cargo_check.rs`, invoked from `semantic_merge.rs`). That is **not** a hook —
> it always runs on the Rust language path. Hooks are the toolchain-agnostic,
> opt-in layer on top.

---

## 2. Core concepts: which events actually fire

`hooks.rs` defines five `HookEvent` variants:

```rust
pub enum HookEvent { PreCommit, PostCommit, PreMerge, PostMerge, PrePush }
```

**Only `PreMerge` is wired into the engine today.** It is the single event
`tier1.rs` discovers and runs (`run_hook_gate`). The other four variants are
declared but have no call sites anywhere in the crate — treat `PreCommit`,
`PostCommit`, `PostMerge`, and `PrePush` as _planned_. The `pre-receive`
server-side event described in `hooks.md` does not exist as a `HookEvent`
variant in the Rust crate at all.

So in practice, "a hook" today means **a pre-merge hook**: an executable file
under `.sharp/hooks/pre-merge/` that runs against the candidate merged tree and
can veto it.

---

## 3. Architecture / design

### Discovery

`discover_hooks(workspace_root, HookEvent::PreMerge)` reads
`<workspace_root>/.sharp/hooks/pre-merge/`. Every entry that is a regular file
(symlinks are resolved) **and** has any POSIX execute bit set (`mode & 0o111`)
is collected. The list is sorted lexicographically — that sort order is the run
order, so prefix names with numbers (`10-clippy`, `20-tsc`) to control
sequencing. A missing directory yields zero hooks, not an error.

```
my-repo/
└── .sharp/
    └── hooks/
        └── pre-merge/
            ├── 10-clippy
            └── 20-tsc-noemit
```

### Execution model

Each hook is spawned (`run_hook`) with:

- **cwd** = a freshly materialized temp copy of the candidate merged tree
  (`materialize_candidate_tree` writes every `path → content` pair into a
  `tempfile::tempdir()`). So a hook can just run `cargo check` / `tsc --noEmit`
  in `.` — it does not need to parse the payload to find the tree.
- **stdin** = a JSON context. The Rust gate currently writes only
  `{"event":"pre-merge","workspaceRoot":"<abs path>"}`. The richer payload in
  `hooks.md` (`candidate_id`, `parent_commits`, `paths_changed`) is **not** what
  the Rust gate emits today — do not rely on those fields.
- **env** = the full inherited environment plus `SHARP_HOOK=1`.
- **timeout** = **hardcoded 60 000 ms** in `tier1.rs`. The `SHARP_HOOK_TIMEOUT_MS`
  variable mentioned in `hooks.md` is _not_ read by the current Rust code; a
  slow cold `cargo check` can hit the wall and be killed.

Hooks run **sequentially**, not in parallel (`run_hooks` loops in order). The
run **short-circuits on the first failure**: a non-zero exit _or_ a timeout
stops the run and the remaining hooks do not execute. A timeout kills the child
(dropped tokio child) and is reported as `exit_code: 137, timed_out: true`.

`run_hook` itself almost never returns `Err` — a hook that fails, times out, or
even fails to spawn is reported through `HookResult` fields (spawn error →
`exit_code: -1`). An `Err` bubbles up only for unexpected host I/O.

### Integration with the merge gate — where hooks run

The pre-merge gate is the **last** step of `tier1_merge`, after the merge has
otherwise succeeded:

1. Classify every path; resolve renames, whitespace-equivalence, concat-adds.
2. Run the Tier-2 oracle selection (if multiple candidates).
3. **Pre-merge hook gate** — only if `Tier1Options.workspace_root` is `Some`.
4. Return `CleanOk { files }`.

If any hook vetoes, `tier1_merge` returns
`MergeOutcome::Dilemma(DilemmaPayload)` — **not** an error. The dilemma names
the failing hook and its stderr, and offers two candidates: `fix_and_retry`
("resolve the issue the hook reported and retry") and `skip_hooks` ("retry
without hooks"). If `workspace_root` is `None`, the gate is skipped entirely.

> There is a second, standalone `run_pre_merge_hooks` helper in `hooks.rs` that
> returns `SharpError::HookVeto` instead of a dilemma. `tier1.rs` does **not**
> call it — it has its own `run_hook_gate`. The helper is a convenience entry
> point for other callers; the two paths share `discover_hooks`/`run_hooks` but
> differ in how a veto is surfaced.

---

## 4. API / interface

```rust
// Discover (sorted, executable-only).
discover_hooks(workspace_root: &Path, event: HookEvent)
    -> Result<Vec<PathBuf>, SharpError>;

// Run one hook; failures live in HookResult, not Err.
run_hook(hook_path: &Path, opts: &HookExecOptions)
    -> Result<HookResult, SharpError>;

// Run many in order, short-circuiting on first failure.
run_hooks(paths: &[PathBuf], opts: &HookExecOptions)
    -> Result<HooksRun, SharpError>; // HooksRun { ok, results }

// Convenience: discover + run pre-merge, HookVeto on failure.
run_pre_merge_hooks(workspace_root, candidate_root, context: Option<String>)
    -> Result<(), SharpError>;
```

`HookResult { hook_path, exit_code, stdout, stderr, timed_out, duration_ms }`;
`HookResult::ok()` is `exit_code == 0 && !timed_out`.

The hook _contract_ from the executable's side is dead simple: **read JSON on
stdin if you want it, do your work in cwd, exit 0 to pass or non-zero to veto.**

---

## 5. Examples

The stock hooks in the TS prototype live under
`deprecated/sharp-ts/examples/hooks/`. They are written as `bun` scripts but the
contract is language-agnostic — any executable works.

### a) Rust clippy / cargo check (`20-cargo-check`)

```sh
#!/bin/sh
# .sharp/hooks/pre-merge/20-cargo-check  (chmod +x)
# cwd is the candidate merged tree.
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-./_cargo-target}"
cargo check --quiet || exit 1
```

Isolating `CARGO_TARGET_DIR` keeps each candidate's artifacts from colliding
with the project's normal `target/`.

### b) TypeScript type-check (`30-tsc-noemit`)

```sh
#!/bin/sh
# .sharp/hooks/pre-merge/30-tsc-noemit  (chmod +x)
[ -f tsconfig.json ] || cat > tsconfig.json <<'JSON'
{ "compilerOptions": { "strict": true, "noEmit": true,
  "moduleResolution": "bundler" }, "include": ["**/*.ts"] }
JSON
tsc --noEmit || exit 1
```

(The original `tsc-noemit.ts` writes a default `tsconfig.json` only when the
tree lacks one — handy for fixture trees in CI.)

### c) Custom validation — read the stdin context

```sh
#!/bin/sh
# .sharp/hooks/pre-merge/05-no-todo
# Reject any merged tree that introduces a FIXME marker.
cat >/dev/null            # drain the JSON context (unused here)
if grep -rn "FIXME" . --include='*.rs' >&2; then
  echo "merged tree contains FIXME markers" >&2
  exit 1
fi
```

Install any of these by dropping the executable (or a symlink to a shared copy)
into `.sharp/hooks/pre-merge/` and setting the execute bit. Lex order across the
filenames above runs `05` → `20` → `30`.

---

## 6. Tradeoffs

- **Portability vs. correctness.** Keeping merge intrinsic-only buys
  language-agnostic merges; the cost is that "does it compile?" lives outside
  the engine, in opt-in hooks you must install.
- **Sequential + short-circuit.** Simple and gives a single, clear failing
  hook, but a slow first hook delays everything and later hooks never report.
- **Full-environment execution.** Hooks inherit your entire env (secrets,
  toolchain paths). Same threat model as Git hooks — see the Security Notes in
  `hooks.md`. Do not install hooks from untrusted sources.
- **Veto = dilemma, not hard error.** A vetoed merge becomes a resolvable
  dilemma (`fix_and_retry` / `skip_hooks`) rather than aborting outright, which
  keeps the human in the loop.

---

## 7. Known limitations & debugging

### Limitations (implemented vs planned)

- **Only `pre-merge` runs.** `pre-commit`, `post-commit`, `post-merge`,
  `pre-push` are declared enum variants with no call sites — planned, not
  implemented. `pre-receive` does not exist in the Rust crate.
- **Timeout is fixed at 60 s.** `SHARP_HOOK_TIMEOUT_MS` (per `hooks.md`) is not
  honored by the current Rust gate.
- **Lean stdin payload.** Only `event` + `workspaceRoot` are provided; the
  richer `candidate_id` / `parent_commits` / `paths_changed` fields in
  `hooks.md` are aspirational.
- **No parallelism, no per-hook config** (no enable/disable file, no allowlist —
  presence + execute bit is the entire configuration surface).

### Debugging a vetoing hook

1. **Read the dilemma.** On veto, `tier1_merge` returns a `DilemmaPayload`
   whose `reason` is
   `pre-merge hook vetoed the candidate tree: <hook path> exited <code> — <stderr>`.
   The failing hook path and its trimmed stderr are right there.
2. **Reproduce by hand.** The cwd is a throwaway temp tree, so the easiest
   repro is to run the same command in a real checkout, or temporarily have the
   hook `pwd` / `ls -R . >&2` so you can see exactly what tree it saw.
3. **stdout and stderr are captured in full** into `HookResult` — anything you
   `echo`/`>&2` from the hook surfaces in the dilemma reason (stderr) and the
   result struct, so log liberally while debugging.
4. **Check the execute bit first.** A non-executable file is silently skipped by
   `discover_hooks` — if your hook "isn't running," `chmod +x` it.
5. **Suspect a timeout?** A killed hook reports `exit_code: 137` /
   `timed_out: true` and the dilemma reason reads `timed out`. Because the
   timeout is fixed at 60 s, split a slow check or pre-warm caches.
6. **Bypass to isolate.** The `skip_hooks` dilemma branch (or simply running the
   merge with `Tier1Options.workspace_root = None`) disables the gate, letting
   you confirm whether the hook — not the merge — is the problem.
7. **Detect hook context.** Hooks run with `SHARP_HOOK=1` in the environment;
   branch on it to make a script behave differently under Sharp vs. a manual run.
