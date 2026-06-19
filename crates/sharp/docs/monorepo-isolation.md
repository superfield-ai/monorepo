# Monorepos Without Pain: Isolation and Governance in Sharp

## **Abstract**

Git submodules and gittrees are notoriously difficult to work with. They introduce hidden state, silent failures, and a steep cognitive load on developers. Rather than accept this pain as inevitable, most teams migrate to monorepos — consolidating all code into a single repository — trading isolation for simplicity. Monorepos come with their own problems: coarse-grained locks, cascading CI failures, and difficulty in enforcing boundaries between loosely-coupled services.

Sharp's semantic merge substrate and single queryable storage substrate offer a new approach: **logical isolation without filesystem fragmentation**. By treating workspace, visibility, and merge boundaries as database-level concerns rather than filesystem-level ones, Sharp can provide the isolation properties teams seek from submodules while retaining the operational simplicity of a monorepo. This document motivates the problem, explores why current solutions fall short, and proposes a framework Sharp can build.

---

## **1. The Problem**

### **1.1 Why Submodules and Gittrees Fail**

Git submodules allow a repository to embed another repository at a specific commit. In principle, this enables:

- Independent versioning of components
- Selective cloning of only needed repositories
- Clear ownership boundaries
- Decoupled release cycles

In practice, they fail catastrophically:

#### **Hidden State and Silent Failures**

Submodule state lives in two places: `.gitmodules` (declared) and `.git/modules/<name>/HEAD` (actual). A developer can commit `.gitmodules` changes without updating the submodule checkout, or vice versa. Cloning a repository with submodules does not automatically initialize them; the developer must remember to run `git submodule update --init --recursive`. Forgetting this leads to silent failures: CI runs on stale submodule commits, developers see old code, and the mismatch only surfaces when something breaks.

#### **Brittle Merge Behavior**

When two branches modify a submodule's pinned commit in different ways, Git cannot merge the changes automatically. The developer must manually resolve the conflict, manually verify that the resulting commit is sensible, and manually test that the merged submodule version is compatible with the rest of the tree. This is tedious even when both sides moved the submodule forward on the same history; it becomes a nightmare when the submodule itself had a merge conflict that one side resolved differently.

#### **No Visibility Into Submodule Changes**

A commit message like "Bump submodule X to 5a7c9d1" tells you the commit hash, but not _what changed_. You must clone the submodule, run `git log 4f2b8e..5a7c9d`, and read the changes yourself. This friction discourages code review and audit; teams often merge submodule bumps without understanding the impact.

#### **Cognitive Overhead**

Developers must understand:

- Which repositories are submodules vs. monorepo-local
- When to run `git submodule update` vs. a plain `git pull`
- How to push changes to a submodule vs. the parent
- How to coordinate a change that touches both parent and submodule
- Why their local state diverged from CI (usually a forgotten submodule init)

Most developers get it wrong frequently, even after years of experience.

#### **Tooling Friction**

IDE support is often broken or incomplete. Many CI systems require special submodule-aware configuration. Bisect, blame, and log operations must be run separately on each submodule. Automation scripts accumulate workarounds for submodule quirks.

### **1.2 Why Monorepos Become Necessary**

When submodules become too painful, teams consolidate into a monorepo — a single Git repository containing many logically independent projects. The appeal is obvious:

- No hidden state; everything is in one place
- No merge conflicts between version declarations and actual code
- Atomic commits across multiple services
- Shared CI infrastructure and a single test run
- Easy cross-service refactoring

But monorepos introduce their own problems:

#### **Coarse-Grained Locks**

Every merge to main locks the entire repository. A failing test in service B blocks unrelated changes to service A from landing. Teams accumulate expensive CI gates (linters, type checkers, tests) that block all merges, not just those that touch the relevant code. A single slow test slows down the entire org.

#### **Weak Service Boundaries**

With everything in one tree, it is trivial to create a dependency on code you were not supposed to depend on. Over time, the monorepo accumulates unintended coupling. Services that should be independently deployable become entangled.

#### **Scaling Pain**

As the monorepo grows, tooling struggles. IDEs slow down. Incremental builds take longer because the build graph is harder to partition. Clone times balloon. Developers increasingly skip running the full test suite locally, reducing confidence in their changes before they hit CI.

#### **Visibility and Secrets**

In a monorepo, all developers have access to all code (unless the VCS enforces per-directory visibility, which most do not). This is a security risk when teams have different confidentiality levels or when third-party contributors should see only certain services. Secrets, API keys, and internal documentation end up scattered across the repo, risking leaks.

#### **No Release Isolation**

If service A and service B are in the same monorepo, they typically share a single version number and a single release tag. This couples their release cycles. If A is ready but B is not, A is blocked. Teams work around this with branches-per-service and cherry-picks, reintroducing the complexity of multi-repo workflows.

### **1.3 The False Dichotomy**

Teams are forced to choose between:

1. **Submodules**: isolation at the cost of cognitive overhead and fragile state management
2. **Monorepo**: simplicity at the cost of weak boundaries and coarse-grained locking

Neither is satisfying. The real problem is that Git's filesystem-based model makes it hard to decouple these concerns. A repository is either "whole" (monorepo) or "federated" (submodules), and there is no middle ground.

---

## **2. What Sharp Can Do Differently**

### **2.1 Logical Isolation Without Filesystem Fragmentation**

Sharp stores all repository state in a single queryable storage substrate (whitepaper §2.3; PostgreSQL in v1), not on a filesystem. This substrate choice unlocks a new approach:

**Treat workspaces, visibility, and merge boundaries as database-level concerns, independent of filesystem layout.**

In Sharp, a "monorepo" and a "multi-repo system" are not two fundamentally different things. Instead, they are points on a spectrum of workspace configuration:

- **Single workspace, multiple services:** All services share a commit graph and a single main branch, but the database tracks which files belong to which service. Visibility, merge gates, and CI targets are service-aware. This is a monorepo-plus: all the operational simplicity of a monorepo, with the boundaries of a multi-repo system.

- **Multiple workspaces, federated by root commit:** Each service is a separate workspace with its own history and refs, but they share a common root or ancestor commit. Merging between workspaces is explicit and bounded. This is submodules-plus: the isolation of submodules, without the hidden state.

- **Hybrid:** Some services share a workspace (for tight coupling), others are isolated (for loose coupling). The boundary is policy, not filesystem structure.

The key insight is that **the filesystem layout and the logical structure are decoupled**. A developer can clone a sparse checkout of only the services they need, but the database still knows about the full tree. CI can selectively run tests based on which services a commit touched, even though the commit touched multiple services in a single tree. Merges respect service boundaries without requiring developers to manually resolve conflicts.

### **2.2 Explicit Version Boundaries**

In a multi-workspace setup, references between services (imports, dependencies) are explicit and tracked. When service A imports from service B, the database records this edge. Merge operations can validate that the resulting state is compatible — e.g., that A's import of B still resolves to a valid version — before committing.

This is similar to how semantic merge works for language-level changes (§6 of the whitepaper), but lifted to the workspace level. The merge engine understands the data-flow graph of the system, not just the syntax tree of individual files.

### **2.3 Selective Visibility and Clone**

Sharp's database tracks which files belong to which service. A developer can request a sparse workspace containing only service A and its transitive dependencies. The Sharp server computes the minimal set of files needed and serves them. This preserves the operational benefit of submodules (small clones) while retaining the simplicity of a monorepo (no hidden state, no manual initialization).

When a change in service A's dependencies affects service B, the developer is automatically notified. When they pull, the transitive dependency is updated atomically, eliminating the "silent submodule stale" problem.

### **2.4 Service-Aware Merge**

Sharp's merge model is already semantic (§6 of the whitepaper): it uses rust-analyzer and the TypeScript compiler to understand the intent of changes, not just the syntax. This can be extended to the service level.

When two branches modify different services, the merge is trivial — no conflict. When both branches modify the same service, the merge proceeds as normal. When both branches modify services that have a dependency relationship, the merge engine can check that the resulting state is valid — i.e., that the dependency constraints are satisfied — before committing.

This prevents a class of hard-to-debug bugs: "we merged two changes and the CI was green, but now service A can't import from service B." The merge gate itself validates cross-service constraints.

### **2.5 Decoupled Release Cycles**

Sharp tracks which commits touch which services (this is already needed for selective CI). A service can be tagged with a release version independent of other services. The database knows that tag v1.2.3 of service A is compatible with service B at v1.1.0, because the commit that creates tag v1.2.3 of A depends only on B at v1.1.0. Teams can release at their own pace without coordinating a single monorepo release.

---

## **3. Proposed Design**

### **3.1 Core Concepts**

#### **Workspace**

A workspace is a logical grouping of files in a Sharp repository. It has:

- A name (e.g., `services/auth`, `packages/ui`)
- A root path (or a list of paths, for multi-root workspaces)
- Declared dependencies on other workspaces
- Visibility rules (who can read/write files in this workspace)
- CI and merge gate configuration (e.g., which tests must pass before merging)

#### **Manifest**

A `WORKSPACES.yaml` (or similar) file at the repository root declares all workspaces and their relationships. It is not mandatory — a repository without this file is treated as a single monolithic workspace. But when present, it governs merge, visibility, and CI behavior.

Example:

```yaml
workspaces:
  services/auth:
    root: services/auth
    depends_on: [shared/db-client, shared/logging]
    owner: auth-team@company.com
    visibility: internal
    ci_gates:
      - test
      - lint
      - cargo check

  services/api:
    root: services/api
    depends_on: [services/auth, shared/db-client]
    owner: api-team@company.com
    visibility: internal

  shared/db-client:
    root: shared/db-client
    depends_on: []
    owner: platform-team@company.com
    visibility: internal

  docs:
    root: .
    pattern: '\.md$'
    visibility: public
```

#### **Sparse Checkout**

A developer checks out only the files they need:

```bash
sharp clone https://repo.example.com/acme/services --sparse services/auth shared/db-client
```

The sparse checkout includes only those workspaces and their transitive dependencies. Sharp's server computes this set using the manifest and serves only those files. The database still knows about the full tree; CI, blame, and history operations see the entire commit graph. A subsequent `sharp pull` automatically brings in any new dependencies discovered in the meantime.

#### **Merge Gate with Dependency Checking**

When merging two branches that touch different workspaces with dependencies, the merge gate verifies:

1. **Syntax validity:** Each service still type-checks and builds (handled by semantic merge and cargo-check gates, already in v1 design)
2. **Dependency resolution:** Imports between services still resolve validly. E.g., if service A imports from service B, does the merged version of B still export what A expects?
3. **Visibility constraints:** A public service does not import from an internal service.

If any gate fails, the merge is rejected (or marked as requiring manual review).

### **3.2 Storage and Semantics**

In the PostgreSQL schema:

- Add a `workspaces` table with metadata about each workspace (name, root, owner, visibility, etc.)
- Add a `workspace_dependencies` table tracking the edges in the dependency graph
- Extend the `blobs` and `trees` tables with an optional `workspace_id` column. If set, the file or directory belongs to that workspace.
- Extend the `commits` table with a `touched_workspaces` denormalized array for quick filtering.

When a commit is created, the merge or write logic computes which workspaces were touched by inspecting the changed files against the manifest.

### **3.3 API and CLI**

#### **CLI**

```bash
# Clone a monorepo and check out only the specified workspaces
sharp clone <url> --sparse <workspace> [<workspace> ...]

# List all workspaces and their status
sharp workspaces list

# Show the dependency graph
sharp workspaces graph

# Create a workspace (must edit WORKSPACES.yaml by hand, for now)
# sharp workspaces create <name> <root> (future)

# Check out additional workspaces without re-cloning
sharp workspaces add <workspace> [<workspace> ...]
sharp workspaces remove <workspace> [<workspace> ...]

# Validate the manifest
sharp workspaces validate
```

#### **Merge API (for agent harnesses)**

```rust
pub struct MergeOptions {
    pub check_workspace_deps: bool,
    pub reject_cross_visibility_imports: bool,
}

pub async fn merge_commit(
    repo: &Repo,
    base: CommitId,
    ours: CommitId,
    theirs: CommitId,
    options: MergeOptions,
) -> Result<CommitId, MergeError>
```

If `check_workspace_deps` is true, the merge gate includes dependency validation. Failures are returned as structured errors that agents can act on.

### **3.4 Backwards Compatibility**

A Sharp repository with no `WORKSPACES.yaml` file behaves exactly like a monorepo: no isolation, no sparse checkout, no dependency checking. Existing workflows are unaffected. As teams add a manifest, the isolation properties gradually take effect.

A Sharp repository can import a Git monorepo and, at the same time, auto-generate a `WORKSPACES.yaml` by analyzing directory structure and imports (e.g., using tree-sitter to find `use` statements in Rust and `import` statements in TypeScript). This gives teams an immediate starting point, though they should refine it by hand.

---

## **4. Trade-Offs and Limitations**

### **4.1 More Manifest to Maintain**

A `WORKSPACES.yaml` is yet another file to keep in sync with the code. If the manifest drifts (e.g., a service adds a dependency but the manifest is not updated), the merge gate may reject valid changes. Teams must treat the manifest as a critical piece of infrastructure and review changes to it carefully.

Sharp should make this friction as low as possible: validate the manifest early, provide good error messages, and consider linting the manifest as part of CI.

### **4.2 Dependency Graph Complexity**

In a large monorepo with many services, the dependency graph can become complex. Circular dependencies must be explicitly forbidden (the database constraint should reject them). Transitive dependency computation can be expensive; sparse checkout needs to traverse the graph to find all transitive dependencies, and large graphs can be slow.

Caching and incremental computation are essential. Sharp should compute the transitive closure once and cache it; computing it on every sparse checkout request is too slow.

### **4.3 Merge Conflict Resolution**

Even with workspace awareness, merge conflicts within a service are still possible and must be resolved by humans (or by sophisticated semantic merge). Workspace isolation does not eliminate merge conflicts; it only simplifies the common case where different services change independently.

### **4.4 Not a Replacement for Monorepo Visibility Control**

While workspace visibility rules restrict what code can import what, they do not prevent a developer from reading the entire repository if they clone it without sparse checkout. True multi-tenant access control (e.g., to prevent a third-party contractor from seeing internal services) requires additional infrastructure: authentication, per-user visibility policies, and possibly encryption. Workspace visibility is a first step, not a complete solution.

### **4.5 Agent Harnesses Must Understand Workspaces**

If an agent harness is making changes that touch multiple services, it must understand the workspace manifest and the dependency constraints. This is additional complexity for harness authors. However, Sharp can provide a library that handles this: compute transitive dependencies, validate merged states, and return structured errors that the harness can act on.

---

## **5. Phased Rollout**

### **Phase 1: Manifest and Data Structure (v2)**

- Add `WORKSPACES.yaml` support with schema validation
- Extend the database schema to track workspace membership and dependencies
- Implement sparse checkout (client-side filtering)
- No merge gate logic yet; workspaces are advisory

### **Phase 2: Merge Gate with Dependency Checking (v2–v3)**

- Implement dependency validation in the merge gate
- Reject merges that violate visibility constraints
- Extend the API to expose dependency information to agent harnesses
- Provide diagnostic tools for debugging dependency issues

### **Phase 3: Transitive Build and Test Caching (v3+)**

- Extend CI to understand workspaces and run only affected tests
- Cache build artifacts per workspace
- Integrate with release tooling to generate per-service release notes

### **Phase 4: Multi-Workspace Federation (v3+, if needed)**

- Support multiple independent workspaces with different histories
- Implement cross-workspace merges and dependency version negotiation
- This is more complex and should be deferred until the benefits are clear

---

## **6. Comparison to Alternatives**

### **Git Submodules / Gittrees**

- **Isolation:** Both provide isolation; submodules and gittrees are explicitly separate repos, workspaces are logical partitions within a single repo
- **State management:** Submodules have hidden state (`.git/modules`); workspaces have only the manifest
- **Merge conflict handling:** Submodules require manual resolution; workspaces can use semantic merge
- **Visibility:** Submodules are all-or-nothing; workspaces support fine-grained rules
- **Verdict:** Workspaces eliminate the cognitive overhead of submodules while retaining the benefits

### **Traditional Monorepo (no isolation)**

- **Simplicity:** Monorepo is simpler (no manifest); workspaces add a small amount of manifest overhead
- **Merge latency:** Monorepo has coarse-grained locks; workspaces can support more granular locks (future work)
- **CI latency:** Monorepo runs all tests; workspaces can run only affected tests (future work)
- **Service boundaries:** Monorepo has weak boundaries; workspaces enforce them
- **Verdict:** Workspaces add safety and scalability to the monorepo model with minimal overhead

### **Polyrepo (many small repos, managed by a build tool like Bazel or Nx)**

- **Isolation:** Polyrepo provides strong isolation via separate repos; workspaces provide logical isolation within a single repo
- **Merge coordination:** Polyrepo requires cross-repo coordination; workspaces atomically merge multiple services
- **Developer experience:** Polyrepo requires learning the build tool; workspaces are part of the VCS itself
- **Verdict:** Workspaces offer an alternative to polyrepo infrastructure, with tighter Git integration and atomic commits

---

## **7. Open Questions**

1. **Partial Merge:** Can we support "merging only certain workspaces" from a branch? E.g., merge only `services/auth` but not `services/api`? This would require more sophisticated merge metadata and could be powerful for large organizations but is also complex.

2. **Visibility in Pull Requests:** How should sparse checkouts affect pull requests? If a developer working on `services/auth` opens a PR, should the PR include the full context (for review) or only the sparse tree (for efficiency)? Probably both: serve the sparse tree to the developer but allow reviewers to request the full tree.

3. **Import Path Rewriting:** If a service is moved from `services/a` to `shared/a`, should imports be automatically rewritten? Or should the old path continue to work as an alias? Sharp's semantic merge could handle this, but it adds complexity.

4. **Workspace Versioning:** Can a workspace have multiple versions (like git branches) within a single monorepo? E.g., `services/auth@v1` and `services/auth@v2`, with different import paths? This would support gradual migrations and canary deployments but is very complex.

---

## **8. Conclusion**

Git submodules and gittrees are painful because they introduce hidden state and require developers to manage multiple repositories manually. Monorepos are simple but lack the isolation and scalability properties teams need.

Sharp's single queryable storage substrate offers a third way: **logical workspaces within a single repository.** By treating isolation as a database-level concern, Sharp can provide the operational simplicity of a monorepo with the service boundaries of a multi-repo system. No hidden state, no manual initialization, no merge conflicts between version declarations and actual code — just a manifest that describes the structure and merge logic that enforces the constraints.

This is not a replacement for polyrepo systems like Bazel or Nx, but it is a compelling alternative for teams that want to stay within the Git ecosystem while scaling beyond a traditional monorepo.
