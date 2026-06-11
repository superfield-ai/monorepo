# Sharp Git Interoperability

Reference for `sharp git import` and `sharp git export`. For the protocol specification see whitepaper §7 and engineering-plan §8.

Sharp's relationship to Git is **bounded and one-shot in each direction**. Sharp is not a Git server, not a Git client, and does not implement bidirectional sync. The two operations exist so that existing Git repositories can be adopted into Sharp without information loss, and so that completed work in Sharp can be backed up or shared on standard Git remotes (GitHub, GitLab, etc.).

---

## `sharp git import <url>`

Ingests an existing Git repository into Sharp, preserving the full object graph.

```bash
sharp git import https://github.com/example/my-repo
```

Sharp shells out to stock `git clone --mirror` for the network and pack work (Sharp does not implement the Git wire protocol), then walks the resulting object database into Sharp's CAS.

### What is preserved

| Item                           | Preserved | Notes                                                                                                    |
| ------------------------------ | --------- | -------------------------------------------------------------------------------------------------------- |
| Full DAG                       | Yes       | Multi-parent merge commits are preserved with all parents in original order. History is never flattened. |
| Tags (lightweight)             | Yes       | Imported as refs under `refs/tags/`.                                                                     |
| Annotated tags                 | Yes       | Tag objects are stored as first-class objects (kind `tag`) with their signature bytes intact.            |
| Signed commits (`gpgsig`)      | Yes       | The `gpgsig` header is part of the commit object bytes Sharp hashes. Signatures survive import → export. |
| HEAD                           | Yes       | Including its symbolic target (`refs/heads/<default-branch>`).                                           |
| `refs/heads/` and `refs/tags/` | Yes       | All branches and tags.                                                                                   |
| Canonical object bytes         | Yes       | Blobs, trees, and commits are stored byte-for-byte as Git canonicalizes them; SHAs are stable on export. |

### What is not preserved

| Item                        | Status       | Notes                                                                                                    |
| --------------------------- | ------------ | -------------------------------------------------------------------------------------------------------- |
| Submodules                  | Partial (v1) | Gitlinks (mode `160000`) are preserved as tree entries. Sharp does not recursively ingest the submodule. |
| Git LFS                     | Partial (v1) | LFS pointer files are ingested as ordinary blobs. The underlying large objects are not fetched.          |
| Non-standard ref namespaces | Not imported | Notes (`refs/notes/`), replace refs (`refs/replace/`), forge-specific PR refs — not imported in v1.      |

The CLI prints a clear warning at import time if submodules or LFS objects are detected so the operator is not surprised later.

Once imported, the repository lives in Sharp. Continued work — commits, branches, merges, agent episodes — happens against Sharp's substrate. There is no automatic re-pull from the source remote. If upstream advances, run another targeted import.

---

## `sharp git export <branch> <url>`

Pushes a completed **linear** Sharp branch to a Git remote as a one-shot backup or sharing operation.

```bash
sharp git export main https://github.com/example/my-repo
```

Sharp builds a fresh `git` bare repository on disk, writes byte-canonical Git objects for every commit on the branch, and uses `git push` for the wire work.

### Linear-only constraint

A branch is exportable if and only if every commit on it has at most one parent reachable from the export tip. Branches with internal merge commits are refused.

To export a branch that has merges, flatten it first:

```bash
sharp export-flatten main --output main-linear
sharp git export main-linear https://github.com/example/my-repo
```

The linear constraint is what makes export deterministic and SHA-stable: every commit Sharp emits has a single parent, so the hash Sharp computes is identical to what the remote computes from the same canonical bytes.

### Byte-identical SHA guarantee

Sharp emits exact Git object bytes:

- Correct tree-entry sort (Git's "directory sort" quirk: entries sorted as if directories had a trailing `/`).
- Exact mode strings: `100644`, `100755`, `120000`, `160000`, `40000` (no leading zero on directory mode).
- Commit header lines in canonical order: `tree`, `parent` (zero or more), `author`, `committer`, optional `gpgsig` and other extension headers, blank line, message body.
- Trailing newline on commit objects.

The SHAs Sharp stores are therefore the same SHAs the Git remote computes. A round-trip — import from GitHub, export back to GitHub — produces stable, matching SHAs without a side-table mapping.

### What exports and what does not

| Data                          | Exports? | Notes                                                                                |
| ----------------------------- | -------- | ------------------------------------------------------------------------------------ |
| Commit graph and source trees | Yes      | All commits on the linear branch and all reachable trees/blobs.                      |
| Annotated tags                | No (v1)  | Only the named branch is pushed. Tags may be added in a future release.              |
| Signed commits (imported)     | Yes      | The `gpgsig` bytes are part of the stored commit object and export verbatim.         |
| Commits authored in Sharp     | Unsigned | Sharp does not hold the operator's GPG/SSH key; Sharp-authored commits are unsigned. |
| Episode metadata              | No       | Episodes, semantic representations, and commit metadata are Sharp-native.            |
| Mutable annotations           | No       | Review status, eval labels, redaction records — none of this appears on the remote.  |

Export is one-shot, not a subscription. Re-running the command after further work pushes the updated branch state.

---

## The Playback Guarantee

Any stock `git` client can clone an exported Sharp branch and check out every commit, byte-for-byte:

```bash
git clone https://github.com/example/my-repo cloned
cd cloned
git log refs/heads/main          # every commit is present and in order
git checkout <any-sha-on-branch> # produces a working tree identical to sharp checkout
```

This guarantee holds because:

1. Sharp stores Git-canonical bytes. The object SHAs Sharp computes match what Git computes.
2. Export is linear-only. A `git clone` of the exported remote sees a normal linear history with no merge commits from Sharp's internal machinery.
3. Signed-commit signatures (from imported commits) verify against the same bytes, in the same tools, before and after the round-trip.

The guarantee is enforced by the **10-repo round-trip suite** in `apps/server/bench/git-roundtrip.ts`, which imports representative open-source repositories and bit-compares commit SHAs on export.

---

## SHA-1DC and `SHARP_ALLOW_RAW_SHA1`

Sharp uses Git's content-addressing hash (SHA-1 by default). In production, Sharp runs SHA-1DC (the collision-detection variant) on every ingested object and rejects anything that triggers collision detection — matching Git's own mitigation of the known SHA-1 weaknesses.

SHA-1DC is not yet fully wired end-to-end in v1. Setting `SHARP_ALLOW_RAW_SHA1=1` on the server bypasses the check so development and testing are not blocked. Do not use this flag in production once SHA-1DC integration is complete.

```bash
# Development: bypass SHA-1DC
SHARP_DSN=postgres://... SHARP_ALLOW_RAW_SHA1=1 bun apps/server/src/index.ts

# Production (once SHA-1DC is wired): omit the flag
SHARP_DSN=postgres://... bun apps/server/src/index.ts
```

Repositories initialized with `objectformat=sha256` use SHA-256 throughout and are not subject to the SHA-1DC gap. The `algo` column on each object row records which hash algorithm was used, supporting mixed-algorithm repositories during the SHA-1 → SHA-256 ecosystem transition.
