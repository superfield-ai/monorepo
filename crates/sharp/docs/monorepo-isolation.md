# Cross-Repository Agent Changes Without a Monorepo

## Status and Scope

This is a post-v1 protocol proposal for Sharp. It addresses one problem:

> An engineering change must be able to read and modify source across repository,
> product, or module boundaries without copying those repositories into one Git history
> or materializing all of their source in one workspace.

Sharp is not trying to replace build systems, package managers, language servers,
release processes, or framework-specific workspace conventions. Those systems may
validate a Sharp change, but they are not part of the source-control protocol.

This report uses three evidence labels:

- **DOCUMENTED:** behavior established by Git, GitHub, or current Sharp code.
- **HYPOTHESIS:** a user or organizational behavior that should be tested through
  interviews, repository analysis, or product telemetry.
- **PROPOSED:** a Sharp behavior that does not exist today.

## Executive Summary

Git makes one repository the unit of history, checkout, branch movement, and atomic ref
publication. A Git commit can change any file in that repository, but it cannot contain
a change to another repository. A submodule only records that another repository should
be at a particular commit. It does not turn work in the two repositories into one change
or one publish operation. Worktrees provide parallel checkouts of one repository, not a
cross-repository change.

The common workaround is to aggregate source. Teams vendor dependencies, construct an
umbrella workspace, or move projects into a monorepo so one commit and one pull request
can cross every relevant boundary. For an agent, this also appears to simplify context:
give the agent one directory and let it search everything. The cost is that source must
be copied, checked out, indexed, authorized, and navigated as a large aggregate even when
the task touches only two small parts of it.

Sharp should make the **change**, not the repository or workspace, the multi-repository
unit. A Sharp change has:

- an immutable **basis** containing exact repository revisions the work started from;
- lazy, repository-qualified source access;
- zero or more candidate commits, one per modified repository;
- opaque validation results supplied by existing tools; and
- an explicit set of compare-and-swap ref updates for publication.

An agent can read `repo-a:src/api.rs` and `repo-b:client/api.ts`, modify both, and produce
one reviewable Sharp change without nesting either repository inside the other. It may
materialize selected files or one repository when a tool requires a filesystem, but the
protocol never requires a combined checkout.

When all target refs are governed by one Sharp authority, Sharp can publish their
expected-old/new values atomically. When the targets are independent Git or GitHub
remotes, Sharp coordinates publication and records partial failure, but does not claim
distributed atomicity.

## 1. The Actual Git Boundary

### 1.1 Similar terms solve different problems

**DOCUMENTED:**

| Mechanism                       | Scope                                                           | Limitation for agent work                                                |
| ------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Git tree object                 | One directory snapshot in one repository object graph           | Cannot refer to a tree in another repository as editable source          |
| Git worktree                    | Another working directory attached to the same repository       | Cannot combine independent repository histories                          |
| Git subtree workflow            | Another project's files copied into one repository              | Aggregates source and requires a convention for upstream synchronization |
| Git submodule                   | A `gitlink` naming a commit expected from another repository    | Records a pin, not a multi-repository change or transaction              |
| Sparse checkout / partial clone | A smaller materialization or object transfer for one repository | Optimizes an aggregate repository; does not cross repository boundaries  |

The official [`git worktree` documentation](https://git-scm.com/docs/git-worktree.html)
defines linked worktrees as several working directories attached to one repository. They
are useful for concurrent agents, but irrelevant to repository composition.

The official [submodule model](https://git-scm.com/docs/gitsubmodules) consists of a
gitlink in the superproject, `.gitmodules` configuration, local initialization state,
and another complete Git repository. Clone does not recurse by default. The submodule
can be missing, detached, dirty, unauthorized, or checked out at a commit other than the
recorded gitlink.

### 1.2 Git has no cross-repository change object

**DOCUMENTED:** a Git commit has one root tree and belongs to one object graph. Git can
make several ref updates atomic at one destination repository with `git push --atomic`,
but [`git push`](https://git-scm.com/docs/git-push) still operates against one destination
repository. It supplies no transaction across unrelated remotes.

This is the important missing primitive. The problem is not merely that submodule
commands are difficult. Git has no durable object that says:

```text
this engineering change started from A@a1 and B@b1,
produced A@a2 and B@b2,
was reviewed and validated as one unit,
and intends to advance both refs or neither.
```

A gitlink can encode `B@b1` inside A, but then A becomes a coordinating repository and
B remains a separately published change. It still cannot express the complete operation
above.

### 1.3 GitHub keeps collaboration repository-scoped

**DOCUMENTED:** GitHub pull requests, protected refs, repository roles, and workflow
tokens are principally repository-scoped. The standard
[`actions/checkout`](https://github.com/actions/checkout) action does not fetch
submodules by default, and its workflow token cannot read a different private repository
without additional credentials.

GitHub can link pull requests and automation can enforce landing order, but this remains
a convention above several repository-local changes. The forge does not provide a
single cross-repository diff, approval state, or atomic merge.

## 2. User and Agent Behavior to Validate

The following are **HYPOTHESES**, not established facts. They explain why a
cross-repository change primitive may be valuable and should become discovery and
evaluation targets.

| Job                              | Compensating behavior                                                    | Failure to test                                                            |
| -------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Change a producer and consumer   | Create related branches and pull requests in two repositories            | Landing order exposes an incompatible intermediate state                   |
| Give an agent enough context     | Clone several repositories or place everything in one umbrella directory | Setup and indexing cost grows with the aggregate rather than the task      |
| Reproduce agent work             | Record branch names, local paths, and setup instructions                 | Branches move and the exact multi-repository basis is lost                 |
| Review a cross-boundary refactor | Follow links among pull requests and reconstruct their relationship      | Reviewers approve repository-local diffs without the whole change intent   |
| Run existing validation          | Build a bespoke workspace containing all candidate repositories          | Validation input differs from the source revisions the agent actually used |
| Publish                          | Push or merge repositories in a prescribed order                         | Interruption or a race produces partial publication                        |

Potential measurements:

- repositories cloned or checked out per agent task;
- bytes and files materialized versus files read or modified;
- tasks producing related branches in more than one repository;
- failures caused by missing, stale, or unauthorized secondary repositories;
- partial publication and manual repair frequency; and
- time spent constructing aggregate workspaces before useful agent work begins.

The product claim should be revised or rejected if these behaviors are rare in the
target customer population.

## 3. Protocol Goals and Non-Goals

### 3.1 Goals

**PROPOSED:** Sharp should provide:

1. One stable identity for an engineering change spanning multiple repositories.
2. An exact, immutable record of every repository revision used as source context.
3. Repository-qualified file and object access without a combined checkout.
4. Per-repository candidate commits linked to the same change.
5. One review and provenance surface for the complete change.
6. An all-or-nothing ref update when all refs share one Sharp transaction authority.
7. Explicit, recoverable non-atomic publication for external Git remotes.
8. Per-repository Git import and export without flattening histories.

### 3.2 Non-goals

The core protocol does not:

- discover or own the dependency graph;
- decide which builds, tests, linters, or deployments should run;
- understand every language's module or package system;
- require a product-wide manifest;
- provide a universal aggregate workspace;
- require cross-repository symbol indexing or graph navigation;
- rewrite import paths when source moves between repositories;
- make arbitrary GitHub repositories transactionally atomic; or
- guarantee that independently released components are compatible.

Sharp's semantic merge capabilities can operate on candidate source where useful, but
language-specific semantics are an optional consumer of this protocol, not a condition
for representing a cross-repository change.

## 4. Minimal Protocol Model

The core model adds one primary object: a **change**. It uses existing repository,
object, commit, ref, and episode concepts.

### 4.1 Repository revision

A repository revision is:

```text
RepoRevision = (authority, repository_id, commit_object_id)
```

The authority and repository identity are required. A digest alone does not identify
which store promises the object, which history makes it reachable, or which policy
governs access.

Paths are always qualified by repository:

```text
SourcePath = (repository_id, path_within_repository)
```

There is no protocol-level path that pretends several repository roots are one tree.

### 4.2 Change basis

The basis is the sorted, duplicate-free set of exact repository revisions from which
the change reads or derives source:

```text
ChangeBasis = [RepoRevision]
```

The basis is task-scoped. It is not a permanent product manifest and does not need to
name every repository in the product. A two-repository change has a two-repository basis
even if the deployed system contains hundreds of repositories.

The basis is frozen once work begins. If an agent later needs source from another
repository, Sharp records a new basis revision before that source is exposed. This keeps
replay honest without forcing the agent to predict all context up front.

Canonical ordering, schema version, authority identity, and object-ID algorithm are part
of the encoding so equivalent bases have one identity.

### 4.3 Change record

A change has a stable `change_id` and an append-only sequence of source revisions:

```text
Change
  change_id
  current_revision
  state: open | sealed | published | partially_published | abandoned

ChangeRevision
  change_id
  revision
  basis: RepoRevision[]
  candidates: CandidateCommit[]
  intended_updates: RefUpdate[]
```

Each candidate commit belongs to exactly one repository and records the corresponding
basis commit as its parent or merge base. Unmodified basis repositories need no
candidate.

An open change may advance to new immutable revisions as its basis or candidates change.
Sealing freezes one revision for validation, review, and publication. Further editing
reopens the change by deriving another revision while preserving its identity and
history. Episodes, validation results, approvals, and publication outcomes are
append-only records attached to a specific revision rather than mutable fields inside
it.

This model does not contain dependency edges, mount points, build targets, ownership
graphs, or release semantics. Higher layers may attach those as typed metadata without
changing the source-control invariant.

### 4.4 Ref update

Every intended publication is explicit:

```text
RefUpdate = (repository_id, ref_name, expected_old, new_commit)
```

The change does not assume that every candidate advances `main`. A component owner may
target an integration ref, a release branch, or no public ref. Existing repository
policy decides who may approve each update.

### 4.5 Validation result

Sharp records validation but does not define the validator:

```text
ValidationResult
  change_id
  change_revision
  validator_name
  input_fingerprint
  status
  artifact_reference
  recorded_at
```

The input fingerprint must identify the sealed change revision and any validator-owned
inputs such as configuration or toolchain versions. Cargo, Bazel, Nx, language-specific
test runners, deployment systems, or a human review can all produce results through the
same small interface.

Sharp policy may require named results before publication. Sharp does not decide how a
validator constructs its filesystem, dependency closure, or build graph.

## 5. Source Access Without an Aggregate Workspace

### 5.1 Repository-qualified reads

An agent operates through the change identity:

```text
sharp change open \
  --base api=sharp://acme/api@refs/heads/main \
  --base client=sharp://acme/client@refs/heads/main

sharp read <change-id> api:src/schema.rs
sharp read <change-id> client:src/generated/schema.ts
```

Sharp resolves each read against the frozen basis. Reads do not follow a moving branch
and do not require either repository to be nested in the other.

The protocol can expose directory listing, file read, history, diff, search within a
named repository revision, and patch application. These are source-control operations,
not a universal IDE or code-intelligence layer.

### 5.2 Lazy materialization

Source is fetched or materialized only when requested:

```text
sharp checkout <change-id> api
sharp checkout <change-id> client --paths src/generated tests/schema
```

A tool that requires a filesystem receives a checkout for the selected repository and
paths. Separate checkouts may sit side by side, but Sharp does not turn their parent
directory into a repository and does not commit aggregate metadata there.

Materialization is a client cache. The authoritative basis remains the repository IDs
and commits in the change. Deleting the local directories does not delete or alter the
change.

### 5.3 Writes

Every write is attributed to one repository-qualified path. A file cannot silently move
across repository boundaries. Such a move is represented as a deletion candidate in one
repository and an addition candidate in another, linked by the shared change and episode
provenance.

Existing tools may edit materialized files normally. Sharp snapshots or patches each
repository independently and stages its candidate commit without moving a public ref.

### 5.4 Authorization

Authorization remains repository-scoped. Every read is re-authorized against current
policy using repository identity and reachability; possession of an object digest is not
an access grant.

The basis remains a reproducible statement of what the change referenced. Replaying it
does not override revoked permissions: a later caller may see an explicit `forbidden` or
`unavailable` repository instead of the original content. Audit retention and replay
authorization are policy concerns, not properties of the change hash.

## 6. Agent Workflow

The complete native workflow is:

1. **Open:** resolve requested refs once and freeze the initial basis.
2. **Read:** access repository-qualified source lazily.
3. **Expand:** add another exact repository revision to a new basis revision when needed.
4. **Write:** record patches or snapshots against individual repositories.
5. **Stage:** create candidate commits without advancing refs.
6. **Seal:** freeze candidate commits and intended ref updates as one revision.
7. **Validate:** attach opaque results from the customer's existing tools and processes
   to that sealed revision.
8. **Review:** present that revision's intent, per-repository diffs, and approvals.
9. **Publish:** compare expected refs and advance all authorized Sharp refs atomically.
10. **Record:** attach publication outcome to the change and agent episodes.

The protocol does not require a branch per agent. An implementation may expose temporary
refs for interoperability or garbage-collection roots, but the durable identity is the
change and its candidate commits.

### 6.1 Native atomic publication

When every intended ref belongs to one Sharp authority:

1. Authorize every individual ref update.
2. Verify every current ref equals `expected_old`.
3. Verify required validation and approval records apply to the sealed revision.
4. Advance all requested refs in one storage transaction.
5. Mark the sealed change published through the same transaction or a transactional
   outbox with an idempotent finalizer.

All ref updates succeed or none do. A failure returns structured stale, unauthorized,
or policy-blocked updates. Candidate commits remain available for rebase or retry.

Atomic publication is optional. A change can intentionally produce candidates without
advancing public refs.

### 6.2 External Git publication

Independent Git and GitHub remotes do not share Sharp's transaction. Sharp can prepare
all commits, verify credentials and expected refs, then push them in a recorded order.
A failure moves the change to `partially_published` with exact observed remote states and
idempotent resume or repair operations.

This is coordinated publication, not atomic publication. The protocol and UI must keep
that distinction visible.

## 7. Relationship to Existing Approaches

Existing multi-repository tools validate the need while stopping short of the proposed
change primitive:

- Google's [`repo` manifest](https://gerrit.googlesource.com/git-repo.git/+/HEAD/docs/manifest-format.md)
  and Zephyr's [`west` manifests](https://docs.zephyrproject.org/latest/develop/west/manifest.html)
  describe and synchronize several repositories into a workspace. Sharp does not need a
  permanent manifest or full workspace; its basis is scoped to one change and source can
  remain lazy.
- [Gerrit topics](https://gerrit-review.googlesource.com/Documentation/cross-repository-changes.html)
  group reviews across repositories. Gerrit documents that cross-repository topic
  submission can partially succeed. Sharp's native mode adds one-authority atomic ref
  publication and durable agent provenance.
- Bazel, Nx, Cargo, and other build tools determine dependency and validation scope.
  Sharp passes them exact candidate revisions and records results; it does not reproduce
  their graphs.
- Git submodules and superprojects can remain an import/export representation. They are
  not Sharp's internal unit of work.

The closest summary is: manifests make a multi-repository **workspace** reproducible;
Sharp should make a multi-repository **change** reproducible without requiring that
workspace.

## 8. Required Sharp Refactor

### 8.1 Establish correct repository/object isolation

Current native objects are keyed globally by digest while carrying one `repo_id`, and
lookup accepts only the digest. Identical content first stored for repository A is not
naturally attributed to repository B, while a caller possessing the digest can request
the bytes without repository context.

Before cross-repository changes, Sharp must separate:

- immutable payload storage keyed by algorithm-tagged object ID; and
- repository reachability establishing which histories may expose that object.

Every public load API must require an authorized repository or change context. Global
deduplication must not imply global readability.

### 8.2 Make single-repository commit staging transactional

Current `commit::commit` stores the object, metadata, each changed path, and the branch
ref through separate operations. Multi-repository atomicity cannot be built on a
single-repository staging path that can fail halfway.

Split the API into:

- `stage_commit(transaction, repo, tree, parents, metadata, paths)` for one immutable,
  internally complete candidate; and
- `update_refs(transaction, updates)` for compare-and-swap publication.

Candidate staging must be idempotent and transactional. It must not advance a ref.

### 8.3 Add a small change module

Add `change.rs` with:

- open and expand basis;
- attach episode;
- stage or replace a repository candidate;
- attach validation and approval results;
- seal;
- publish; and
- query status and per-repository diff.

Do not add composition graphs, workspace dependency relations, build-target schemas, or
language-specific fields to this core module.

### 8.4 Adapt existing modules

| Current area     | Minimal change                                                                            |
| ---------------- | ----------------------------------------------------------------------------------------- |
| `repo.rs`        | Give repositories stable authority-qualified identity                                     |
| `object.rs`      | Separate payload from repository reachability; require scoped loads                       |
| `commit.rs`      | Stage complete immutable commits without ref movement                                     |
| `refs.rs`        | Add one transaction over a sorted set of expected-old/new ref updates                     |
| `episode.rs`     | Let an episode attach to a `change_id`; qualify artifacts by repository                   |
| `workspace.rs`   | Keep single-repository materialization; add optional path-limited checkout                |
| `git_interop.rs` | Preserve gitlinks and allow their repositories to be added to a change basis on demand    |
| merge flow       | Merge candidates per repository; leave cross-repository validation to attached validators |

The wider Superfield `workspace_id` remains a tenant-isolation concept. It is unrelated
to a Sharp change basis or local checkout.

## 9. Git and GitHub Interoperability

### 9.1 Import

Sharp imports each Git repository as its own history. A gitlink remains byte-preserved in
the parent repository. When an agent follows that link for a task, Sharp may resolve the
repository and exact commit into another basis entry. It does not recursively import or
materialize every submodule merely because one exists.

Unavailable or unauthorized gitlinks remain explicit. Sharp never substitutes a default
branch for the recorded commit.

### 9.2 Export

Each candidate repository exports independently under the existing
[`git-interop.md`](./git-interop.md) contract. Sharp does not need a flattened monorepo
export because no aggregate tree exists in the protocol.

Change metadata can export as a portable sidecar containing the basis, candidate commit
IDs, intended updates, validation references, episode provenance, and publication
outcome. Ordinary Git consumers see valid repository histories even if they ignore the
sidecar.

### 9.3 GitHub bridge

A bridge may create one GitHub pull request per candidate repository and link them to one
Sharp change. The Sharp page carries the full intent and publication state; each GitHub
pull request remains repository-local. Partial external publication is recorded rather
than hidden.

## 10. Delivery Plan

### Phase 0: correctness prerequisites

- Separate object payload storage from repository reachability.
- Require repository/change context for object reads.
- Make candidate commit staging transactional and independent of ref movement.
- Add authorization and crash-recovery tests for those invariants.

### Phase 1: read-only multi-repository changes

- Open a change with an exact basis.
- Expand the basis explicitly.
- Read, list, diff, and selectively materialize repository-qualified source.
- Attach episodes and record exactly which source each agent accessed.

This is the first product test: can an agent work across two repositories without an
umbrella checkout?

### Phase 2: candidates and review

- Record repository-qualified patches and snapshots.
- Stage one complete candidate commit per changed repository.
- Seal a change and display per-repository plus aggregate change summaries.
- Attach opaque validation and approval results.

### Phase 3: publication

- Implement multi-repository ref compare-and-swap under one Sharp authority.
- Add structured stale-ref retry and rebase behavior.
- Add external Git coordinated publication and partial-failure recovery.

## 11. Acceptance Criteria

1. A change basis identifies every repository revision read by an agent.
2. An agent can read and edit two repositories without nesting, vendoring, or fully
   checking out either repository.
3. Every path, patch, artifact, and candidate remains repository-qualified.
4. Deleting local materializations does not affect the durable change.
5. A sealed change produces ordinary per-repository commits with no aggregate tree.
6. Existing tools can attach validation without Sharp understanding their build graph.
7. Ref publication under one Sharp authority updates all intended refs or none.
8. A publication race reports the exact stale refs and preserves all candidates.
9. External partial publication is explicit and resumable.
10. Per-repository Git playback remains valid.
11. Repository authorization is enforced even when payloads are globally deduplicated.
12. No product-wide manifest, dependency graph, or universal workspace is required by
    the protocol.

Initial performance measurements should focus on source bytes materialized per task,
time to first useful agent read, number of repositories and files accessed, candidate
staging latency, and multi-ref publication latency. Numerical targets should follow
measurement rather than appear as untested guarantees.

## 12. Open Questions

1. How should a basis revision be represented when an agent discovers another repository
   halfway through an episode: a new immutable basis version or an append-only access
   log plus a final sealed basis?
2. What minimum repository operations must be available without materialization beyond
   list, read, history, diff, search, and patch?
3. Should candidate commits be rooted in temporary refs for Git interoperability, or can
   change reachability alone protect them from garbage collection?
4. How are repository-specific approvals combined without granting every reviewer read
   access to every candidate?
5. What retention guarantee makes an old basis replayable when an external origin
   deletes objects?
6. Does aggregate review reveal names or metadata from repositories a reviewer cannot
   read, and what redaction is safe?

## Conclusion

The source-control failure is not that Git lacks another workspace manager. It is that
the repository is both the history boundary and the largest possible change boundary.
When engineering work crosses that boundary, users must coordinate several local changes
or erase the boundary by aggregating source.

Sharp should keep repository histories independent and make a cross-repository change
first-class. The change records exact bases, exposes source lazily through
repository-qualified paths, stages independent commits, carries shared intent and agent
provenance, and publishes explicit ref updates. Existing build and language tools remain
responsible for interpreting and validating the source.

This is smaller than repository federation and more useful to agents: no permanent
composition, no universal workspace, and no requirement to import the world before work
can begin.
