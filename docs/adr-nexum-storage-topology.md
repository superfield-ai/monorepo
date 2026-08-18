# ADR: Nexum Storage Topology and External Deployment Shape

**ADR number:** 004  
**Decision date:** 2026-08-07  
**Status:** Accepted — closes #890  
**Canonical reference:** `docs/architecture.md` §Single-Instance Database Schema Layout, `docs/adr-schema-boundary.md` (ADR 001)

> ADR numbering note: ADR 001 is `docs/adr-schema-boundary.md`. `docs/adr-embedding-model.md`
> and `docs/adr-ci-execution-manifest.md` predate the numbering convention and carry no
> number; they are treated as 002 and 003 respectively. This ADR takes 004.

---

## Context

Nexum (`crates/nexum`) is today an **in-process component of this monorepo**. It owns the
`nexum` PostgreSQL schema, its migrations live at `crates/nexum/migrations/`, and they are
applied by the shared runner in `crates/sf-db/src/migrate.rs` alongside every other
component's migrations. Both facts encode an assumption that ADR 001 made deliberately and
`docs/architecture.md` §Single-Instance Database Schema Layout still owns: **one Postgres
instance, one schema per component, all components co-resident.**

That assumption is correct for this monorepo and is not being revisited here.

The new pressure is external. A separate product wants to adopt nexum as its knowledge-base
substrate. It has its own Postgres instance, its own schemas, and its own tenancy model. It
cannot join this monorepo's shared instance, and this monorepo cannot accept its tables. Nine
issues (#890–#898) build that external product surface; this ADR is the first, and every
sibling depends on the answers below:

1. **How does nexum learn which database to write to** if not "the monorepo's shared one"?
2. **What deployment shape does an external consumer actually run?**
3. **Can the `nexum` schema safely coexist inside a database that nexum does not own** —
   i.e. can it be confined to a role that cannot touch the consumer's own data?

Question 3 is the load-bearing one. An external consumer will not adopt a component that
demands superuser or open access to its production database. Until schema-coexistence under
a confined role is *demonstrated*, every downstream issue is building on an assertion.

A fourth question falls out of question 3 and must be answered here because it is the one
place today's schema reaches outside itself: `nexum.page_revisions.workspace_id` carries a
foreign key to `public.workspaces`, a table owned by `sf-db`, not by nexum.

---

## Decision

### 1. The database target is caller-configured, not component-owned

Nexum does not construct, discover, or own a database connection. It receives one.

The **caller-configured database target** mechanism is the existing sf-db configuration
surface, which this ADR ratifies as the external contract:

| API | Contract |
| --- | --- |
| `sf_db::DbConfig::from_url(url)` | Explicit injection. The caller supplies the connection string; nexum never reads the environment. This is the mechanism external embedders use. |
| `sf_db::DbConfig::from_env()` | Reads `DATABASE_URL` (plus optional `DATABASE_POOL_MAX_CONNECTIONS`). This is the mechanism the standalone container uses, because a container's configuration surface *is* its environment. |
| `sf_db::connect(&cfg) -> PgPool` | Produces the pool. Callers holding an existing `PgPool` may pass it in directly and skip `DbConfig` entirely. |

Both constructors validate that the target is a `postgres://` or `postgresql://` URL and
carry no default value — there is no fallback to a hardcoded host, port, database name, or to
this monorepo's shared instance. A missing target is an error, not a default.

**Consequence for callers:** the pool is an input to nexum, so pool injection is the primitive
and every other configuration style (env var, config file, secret manager) is the caller's
concern, resolved before nexum is constructed. Nexum's storage dependency is therefore fully
described by "a `PgPool` pointed at a Postgres 16+ database satisfying §3 below".

### 2. The external deployment shape is a standalone container against the consumer's own Postgres

An external consumer runs nexum as a **standalone container** in its own cluster, reaching
its own Postgres over the network. Concretely:

- **One process, one image.** The container runs nexum and nothing else. It does not embed,
  provision, or supervise a Postgres — `crates/sf-db/src/provisioner.rs`
  (`LocalPostgresProvisioner`) is an *appliance* facility for this monorepo's self-hosting
  boot path and is explicitly **not** part of the external deployment shape.
- **Configuration is `DATABASE_URL`** (§1), injected by the consumer's orchestrator from its
  own secret store.
- **The database is the consumer's**, pre-existing, containing the consumer's own schemas.
  Nexum is a tenant inside it, not its owner.
- **Migrations are applied by the nexum container at boot**, against the `nexum` schema only,
  using the same discover-then-apply runner this monorepo uses. Boot order is
  provision-independent: connect → migrate → serve.
- **No cross-schema joins.** ADR 001's central benefit — cheap joins across `sharp`, `nexum`,
  and `orchestrator` in one instance — does not exist in the external shape, because those
  other schemas are not there. External nexum is a self-contained knowledge-base substrate
  reachable only through its own API surface (that API boundary is sibling #892's scope).

The in-monorepo path is unchanged. Nexum continues to run in-process against the shared
instance, with its migrations applied by the shared runner in the canonical
`sf-db → sf-auth → nexum → sharp → orchestrator` order. This ADR adds a second supported
topology; it does not replace the first.

### 3. The nexum schema coexists under a dedicated, scoped Postgres role

An external consumer provisions **one dedicated role** for nexum. That role is
`NOSUPERUSER`, `NOBYPASSRLS`, `NOCREATEDB`, `NOCREATEROLE`, and owns the `nexum` schema and
nothing else.

The operator performs this one-time provisioning **as an administrator, before nexum boots**:

```sql
-- 1. The confined role. No superuser, no RLS bypass, no role/db creation.
CREATE ROLE nexum_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE
  PASSWORD '<from the consumer secret store>';
GRANT CONNECT ON DATABASE <consumer_db> TO nexum_app;

-- 2. Extensions. Installing an extension is an administrator action; nexum's
--    migrations use CREATE EXTENSION IF NOT EXISTS, which is a no-op (a NOTICE,
--    not an error) once the extension is present, so the confined role never
--    needs the privilege to install one.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "vector";

-- 3. The nexum schema, owned by the confined role. Pre-creating it means the role
--    never needs CREATE on the database itself.
CREATE SCHEMA nexum AUTHORIZATION nexum_app;

-- 4. The tenancy anchor and its two sanctioned cross-schema grants (see §4).
--    public.workspaces is created from crates/sf-db/migrations/0001_workspaces.sql.
GRANT USAGE ON SCHEMA public TO nexum_app;
GRANT SELECT, REFERENCES ON public.workspaces TO nexum_app;

-- 5. Keep the migration ledger inside the nexum schema, not in public.
ALTER ROLE nexum_app IN DATABASE <consumer_db> SET search_path = nexum, public;
```

**The privilege envelope this ADR sanctions is exactly:**

| Privilege | Object | Why |
| --- | --- | --- |
| `USAGE`, `CREATE` (via ownership) | schema `nexum` | Nexum owns its schema. |
| all privileges (via ownership) | every table in schema `nexum` | Created by nexum's own migrations. |
| `CONNECT` | the consumer database | Required to connect. |
| `USAGE` | schema `public` | **Sanctioned exception.** Needed to resolve `public.workspaces`. |
| `SELECT`, `REFERENCES` | `public.workspaces` | **Sanctioned exception.** See §4. `REFERENCES` is required to declare the FK; `SELECT` to validate rows. Notably *not* `INSERT`/`UPDATE`/`DELETE`: nexum reads the tenancy anchor, it does not manage tenants. |

**Nothing else.** In particular the role holds **no** privilege on any other schema in the
consumer's database — no `USAGE`, no `SELECT`, nothing. It cannot enumerate, read, or write
the consumer's own tables. It has `NOBYPASSRLS`, so any RLS the consumer applies to its own
tables binds nexum too. Two properties make this hold rather than merely be intended:

- The role has **no `CREATE` on schema `public`** (PostgreSQL 15+ revokes it from `PUBLIC` by
  default, and this ADR forbids re-granting it), so nexum cannot plant objects in the
  consumer's default namespace. The `search_path` setting in step 5 is what keeps the
  runner's `schema_migrations` ledger inside `nexum` rather than attempting `public`.
- The role is not the database owner, so it inherits no implicit authority over it.

This is a **negative invariant**, and negative invariants rot silently. It is therefore
enforced by an executed test rather than by this document — see §Proof.

### 4. `nexum.page_revisions` → `public.workspaces` resolves as a mandatory tenancy anchor

`crates/nexum/migrations/0003_page_revisions.sql` declares
`workspace_id UUID NOT NULL REFERENCES public.workspaces(id)`. The options were: drop the FK
for external deployments; move `workspaces` into the `nexum` schema; or require it.

**Decision: the FK stays, and `public.workspaces` becomes part of nexum's declared storage
contract as a *tenancy anchor* the external consumer must provide.**

The external consumer applies `crates/sf-db/migrations/0001_workspaces.sql` — a single table
with no dependency on the rest of sf-db — into its database's `public` schema as an
administrator, then grants the confined role `SELECT` and `REFERENCES` on it (§3). Nexum's
migrations then apply unmodified: **byte-identical SQL runs in both topologies.**

Rationale:

- **Tenancy is not optional and must not be advisory.** Every downstream external issue
  (#893's per-workspace dedup key, #894's retention and legal hold, #895's sensitivity tiers)
  keys on `workspace_id`. A dangling `workspace_id` with no referential integrity would make
  cross-tenant leakage a *data* bug rather than something the database refuses. Enforcement
  belongs in the database.
- **It keeps one migration corpus.** Forking nexum's SQL by topology — an `#[cfg]`-style
  split between "internal" and "external" migrations — would double every future nexum
  migration and guarantee eventual divergence. This is the single most important property
  for siblings #893/#894/#896, whose migration numbers are already reserved: they write one
  SQL file that works in both topologies.
- **The cost is one table and two grants**, both narrow and both read-only. The consumer maps
  its own tenant concept onto `workspaces` rows (`slug`, `display_name`) and owns their
  lifecycle. Nexum never writes them.
- **It does not violate ADR 001.** `public.workspaces` is already the documented, deliberate
  exception to one-schema-per-component (`docs/architecture.md` §Schema namespace
  assignment: "the shared tenant root every component's `workspace_id` FKs against"). This
  ADR carries that existing exception into the external topology rather than inventing a new
  one.

Moving `workspaces` into the `nexum` schema was rejected: it would make nexum the owner of a
table that `sharp`, `auth`, and `orchestrator` also FK against in this monorepo, inverting
the dependency direction of the entire substrate to serve the external case.

---

## Rationale

**Why ratify the existing `DbConfig` surface instead of designing a new one?** Because
`from_url`/`from_env` already have exactly the required shape — no defaults, no discovery,
validation at the boundary — and they are already the path both the appliance boot sequence
and the integration suites use. Inventing a nexum-specific configuration type would add a
second way to say the same thing and a translation layer between them. The decision this ADR
records is therefore mostly a *constraint*: nexum must not grow any other way to acquire a
database.

**Why a standalone container rather than a library the consumer links?** A library would drag
the Rust toolchain, the workspace's dependency graph, and the embedding model's weight
governance into the consumer's build. The container makes nexum's substrate requirements
(Postgres 16+, `pgvector`, `pgcrypto`) explicit and version-locked, and it is the shape the
network boundary in sibling #892 assumes.

**Why prove coexistence with a test rather than assert it?** Everything in §3 is a claim about
what a role *cannot* do. Compilation cannot check it, and a documented grant list drifts from
the migrations the moment a migration adds a table. Only executing the provisioning against a
live Postgres and enumerating the resulting privileges keeps the claim true over time.

---

## Proof

`crates/sf-db/tests/external_nexum_scoped_role_integration.rs` is the executed proof of §2–§4.
Against a live Postgres it:

1. Creates a **fresh database** distinct from any Superfield database, standing in for the
   consumer's own instance.
2. Creates a **consumer-owned schema with a table in it** (`consumer_app.customers`) *before*
   nexum boots — the data nexum must never be able to reach.
3. Performs exactly the operator provisioning in §3 — no more privileges, no shortcuts.
4. Connects **as the confined role** via `DbConfig::from_url` + `connect` (§1) and applies
   nexum's migrations, asserting all three apply, that re-running applies nothing, and that
   the `schema_migrations` ledger landed in `nexum` and **not** in `public`.
5. Asserts the role really is `NOSUPERUSER` / `NOBYPASSRLS` / `NOCREATEDB` / `NOCREATEROLE`.
6. Enumerates the role's grants from `information_schema.role_table_grants` and asserts every
   row is either in schema `nexum` or is `SELECT`/`REFERENCES` on `public.workspaces` — the
   §3 envelope and nothing else — cross-checked with `has_schema_privilege`, including that
   the role has **no** `CREATE` on `public` and **no** `USAGE` on `consumer_app`.
7. Asserts the confined role is actually refused when it tries to read
   `consumer_app.customers`.

The test executes in CI in `.github/workflows/rust.yml`'s `rust-test-seam` job against a
`pgvector/pgvector:pg16` `services:` container. It is selected by
`scripts/rust-test-seam-filter.txt` and run under `--run-ignored all --no-tests=fail`, so it
executes rather than skips. `SF_DB_REQUIRE_DB=1` is set on that job: with the marker set and
`DATABASE_URL` absent the test **fails loudly** instead of skipping, so losing the database
cannot turn into a false green (`docs/testing-invariants.md`).

---

## Rejected alternatives

| Option | Why rejected |
| --- | --- |
| External consumers join this monorepo's shared Postgres instance | The consumer has its own instance and its own operational boundary. This is the constraint that motivated the issue, not a solution to it. |
| Nexum owns a separate Postgres *database* per deployment, provisioned by nexum | Requires `CREATEDB` and effectively administrator authority in the consumer's cluster. Consumers will not grant it, and it makes nexum responsible for a lifecycle it cannot see. |
| Nexum reads `DATABASE_URL` internally as its own configuration source | Hides the dependency and makes nexum untestable against two databases in one process. Injection (§1) subsumes it: the container reads the env, nexum receives a pool. |
| Fork nexum's migrations into "internal" and "external" variants | Doubles every future migration and guarantees divergence. Rejected in §4. |
| Drop the `page_revisions` → `workspaces` FK for external deployments | Demotes tenant isolation from a database-enforced invariant to a convention, in the exact topology where nexum is a guest in someone else's database. Rejected in §4. |
| Give the nexum role `CREATE` on schema `public` so the migration ledger can live there | Lets nexum plant objects in the consumer's default namespace and collide with the consumer's own tables. The `search_path` setting in §3 achieves the same result with no privilege. |
| Grant the nexum role blanket `USAGE` on all schemas for "operational convenience" | Defeats the entire coexistence claim. The envelope in §3 is exhaustive by design and asserted by the test. |

---

## Consequences

**Enabling.**

- Siblings #892–#898 can assume: a caller-supplied `PgPool`, a `nexum`-schema-only privilege
  envelope, a `public.workspaces` tenancy anchor, and a standalone-container deployment
  shape. #893/#894/#896's reserved migrations write one SQL file for both topologies.
- The privilege envelope is now a regression-tested invariant, not documentation. A future
  migration that reaches outside `nexum` (or a widened grant) fails the test in CI.

**Costs and constraints accepted.**

- **External consumers must run the operator provisioning in §3.** It is a documented
  prerequisite, not something nexum can do for itself — by design, since doing it for itself
  would require the privileges the confined role deliberately lacks. Packaging it as a
  first-run script is sibling #898's (packaging) scope.
- **`public.workspaces` is a hard external dependency.** Consumers must create it and maintain
  its rows. This is the sharpest cost of the §4 decision and is accepted knowingly.
- **`pgvector` and `pgcrypto` must be pre-installed** by an administrator. Postgres 16+ is
  required. Managed Postgres offerings without `pgvector` cannot host external nexum.
- **No cross-schema joins in the external topology.** Anything needing to combine nexum data
  with consumer data does so above the database, through nexum's API.
- **This ADR does not make nexum a separately versioned artifact.** Packaging, image build,
  manifests, and semver are sibling #898. Until that lands, "standalone container" is a
  decided shape with a proven storage contract, not a published image.

**Not changed.**

- The in-monorepo topology, ADR 001, `docs/architecture.md` §Single-Instance Database Schema
  Layout, the shared runner's component order, and every existing Sharp/Nexum caller are
  untouched. `crates/nexum/migrations/` gains no new migration from this ADR.
