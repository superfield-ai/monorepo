# Git fixtures

The dev-loop e2e harness needs a git remote that `WorktreeManager.create` can
clone from without touching the network or shelling out to the `git` binary.
Rather than committing a bare repository into the tree (which bloats the repo
and is fragile to edit), the fixture is **materialized at test time** by
`packages/core/tests/integration/helpers/git-remote.ts`.

## Format

At the start of a test the helper:

1. Creates a tmp directory under `opts.tmpRoot`.
2. Initializes a bare repo with `git.init({ bare: true })` from
   `isomorphic-git`.
3. Writes blobs/trees directly via the plumbing APIs (`writeBlob`,
   `writeTree`, `writeCommit`) and points `refs/heads/main` at the resulting
   commit. Default seed files:
   - `README.md`
   - `packages/core/index.ts`
   - `docs/prd.md`
4. Spins up a localhost smart-HTTP server bound to `127.0.0.1:0` (a random
   free port) that implements just enough of the git smart-HTTP backend for
   `isomorphic-git` clone/fetch/push to succeed.
5. Returns `{ remoteUrl, baseUrl, owner, repo, dispose }`.

`remoteUrl` is of the form `http://127.0.0.1:<port>/<owner>/<repo>.git` and
can be passed directly to `git.clone`, or — for the production
`WorktreeManager` — via its `baseUrl` constructor option:

```ts
const remote = await createTestGitRemote({ tmpRoot });
const wm = new WorktreeManager({ baseUrl: remote.baseUrl, root: ... });
await wm.create({ owner: remote.owner, repo: remote.repo, ... });
```

`dispose()` awaits `server.close()` and `rm -rf`s the tmp directory. Tests
must call it in a `finally` to avoid leaking ports or temp dirs.

## Adding commits to new branches

Use `seedCommitsOnRemote(remoteUrl, [{ branch, files }])`. It clones the
remote into a throwaway tmp dir via `isomorphic-git`, creates/checks out the
branch, writes the files, commits, pushes back, and cleans up. Useful for
tests that need a pre-existing branch (for example, simulating an
already-merged scout PR).

## Why an HTTP server instead of `file://`

`isomorphic-git` only registers remote helpers for `http://` and `https://` —
any `file://` URL throws `UnknownTransportError`. The client also requires
the **smart** HTTP protocol (it errors on missing
`# service=git-upload-pack` / `application/x-git-upload-pack-advertisement`
responses), so we can't get away with a static file server either. The
helper therefore implements a minimal smart-HTTP backend inline using
`isomorphic-git`'s own primitives (`packObjects`, `readCommit`, `readTree`,
`writeRef`, `indexPack`). The server handles:

- `GET /<owner>/<repo>.git/info/refs?service=git-upload-pack`
- `POST /<owner>/<repo>.git/git-upload-pack`
- `GET /<owner>/<repo>.git/info/refs?service=git-receive-pack`
- `POST /<owner>/<repo>.git/git-receive-pack`

That is enough for the dev-loop e2e harness's full clone + push cycle. It is
**not** a production-grade git server; it only implements the capability
subset that `isomorphic-git` actually negotiates.
