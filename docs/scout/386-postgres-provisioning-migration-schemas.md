# Scout: Current Postgres Provisioning, Migrations, and Schemas

**Issue:** #386
**Phase:** Substrate foundations
**Feeds:** unified migration runner, shared schema layout issues downstream

---

## Summary

Every active subcomponent that uses Postgres is inventoried here: provisioning
mechanism, migration runner, schema, vector columns, and AGE second-instance
usage. This is the baseline the unified migration runner (target state: one
Rust binary, one Postgres instance) must be designed against.

---

## Inventory by Component

### 1. Nexum (`superfield-ai/nexum`)

| Property             | Current state                                                                                                                     |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Image**            | `pgvector/pgvector:pg16` (port 5432, primary)                                                                                     |
| **Provisioning**     | `docker-compose.yml` — manual `docker compose up`                                                                                 |
| **Migration runner** | Custom TypeScript: `src/db/migrate.ts`                                                                                            |
| **Schema file**      | `db/schema.sql` — applied idempotently via `migrate()`                                                                            |
| **Schema version**   | No version table — raw SQL file re-applied on every boot                                                                          |
| **Vector columns**   | `blocks.embedding vector(384)` (cosine HNSW index), `links.edge_embedding vector(384)` (cosine HNSW, stub — populated by Phase 2) |
| **Extension**        | `pgcrypto`, `vector`                                                                                                              |
| **DB name**          | `nexum` (user: `nexum`, pass: `nexum`)                                                                                            |
| **Config env var**   | `DATABASE_URL` (default: `postgresql://nexum:nexum@localhost:5432/nexum`)                                                         |

**Schema tables:**
`corpora`, `documents`, `document_versions`, `blocks`, `version_blocks`,
`links`, `entities`, `corpus_access`, `job_queue`

**Migration mechanism detail:**
`migrate()` in `src/db/migrate.ts` reads `db/schema.sql` as a single string,
splits it on semicolons (with dollar-quote awareness), and executes each
statement on the primary pool. No version table — the file uses
`CREATE TABLE IF NOT EXISTS` and `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
throughout, so re-running is idempotent but cannot undo past statements.

---

### 2. Nexum — Apache AGE second instance (non-conforming)

| Property             | Current state                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------------- |
| **Image**            | `apache/age:PG16_latest` (port **5433**, separate service)                                          |
| **Provisioning**     | `docker-compose.yml` — `postgres-age` service alongside primary                                     |
| **Migration runner** | `docker-entrypoint-initdb.d` hook on first boot + `src/db/migrate.ts::migrateAge()`                 |
| **Schema file**      | `db/migrations/0001_age_shim.sql`                                                                   |
| **Schema version**   | No version table — idempotent DO $$ ... $$ block only                                               |
| **Graph**            | `nexum_links` graph; vertex label `Block`; edge label `LINK`                                        |
| **Config env var**   | `AGE_DATABASE_URL` (default: empty — AGE is **optional**)                                           |
| **Runtime**          | `src/db/age.ts` — lazy pool, silent no-op when `AGE_DATABASE_URL` is unset or AGE extension missing |

**Non-conformance flag:** Architecture requires one Postgres instance. The
AGE second service on port 5433 is explicitly identified as non-conforming by
the architecture doc: it must be folded into the single instance, not
accommodated. The AGE shim was created in Phase 1 (issue #78) as a scout stub;
real AGE writes land in issue #75.

**Integration points discovered:**

- `src/db/age.ts::writeAgeEdge()` — dual-write path for every new link edge
- `src/db/migrate.ts::migrateAge()` — called at end of `migrate()`; applies SQL files from `db/migrations/` against `AGE_DATABASE_URL`
- Both paths are guarded: if `AGE_DATABASE_URL` is unset or the `age` extension is absent, execution silently continues using only the primary instance.

---

### 3. Sharp (`superfield-ai/sharp`)

| Property             | Current state                                                                                                          |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Image**            | Not in compose — tests use a per-run Docker container (`tests/harness/pg-container.ts`)                                |
| **Provisioning**     | No persistent docker-compose; production deployment uses `SHARP_DSN` env var                                           |
| **Migration runner** | Custom TypeScript: `apps/server/src/migrate.ts`                                                                        |
| **Schema version**   | `schema_migrations` table (version + name + applied_at); sequential `NNNN__name.sql` files applied inside transactions |
| **Extensions**       | None (standard Postgres only — no pgvector, no AGE)                                                                    |
| **Config env var**   | `SHARP_DSN` (required — no default); `SHARP_MIGRATE_ON_BOOT` (default: migrate on boot)                                |
| **DB name**          | Operator-chosen (from DSN)                                                                                             |

**Migration files:**

| File                    | Contents                                                                                  |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| `0001__init.sql`        | `repos`, `objects` (git object store, SHA-1/SHA-256)                                      |
| `0002__refs.sql`        | `refs` (git ref names → object hashes)                                                    |
| `0003__commits.sql`     | Commit-specific tables                                                                    |
| `0004__auth.sql`        | `api_keys` (bearer tokens, scopes: read/write/operator)                                   |
| `0005__episodes.sql`    | `episodes`, `episode_artifacts`, `episode_links`, `episode_redactions`, `representations` |
| `0006__analytics.sql`   | Analytics tables                                                                          |
| `0009__projections.sql` | `projections` + trigger `mark_projections_stale()` on ref updates                         |

Sharp's migration runner (`apps/server/src/migrate.ts`) is the most structured
of the three: it uses a `schema_migrations` table, applies each file in a
transaction, skips already-applied versions, and detects duplicate version
numbers at startup. It is the closest to what the unified runner needs.

---

### 4. CLI repo (`superfield-ai/superfield-cli-ts`)

The CLI repo itself has **no Postgres instance**. Its `packages/db` package
uses [lowdb](https://github.com/nicolo-ribaudo/lowdb) (a JSON file-backed
store) for local issue state:

| Property           | Current state                                                                                                         |
| ------------------ | --------------------------------------------------------------------------------------------------------------------- |
| **Store**          | `lowdb` — JSON file at `.superfield/issues.json`                                                                      |
| **Migration**      | `migrate()` shim in `packages/db/index.ts` — no-op; the embedded store self-initializes                               |
| **Schema version** | `version: 1` field in the JSON file                                                                                   |
| **Postgres usage** | `packages/db/pg-container.ts` — test utility only; spins up a throwaway `postgres:16` container for integration tests |

The `pg-container.ts` in the `@superfield/db` package is **unused** by runtime
code. The control integration tests have their own copy at
`packages/control/tests/helpers/pg-container.ts`. Both start an ephemeral
`postgres:16` container via `docker run` and return a connection URL.

---

### 5. CLI — K8s deployment templates (app-side Postgres)

The CLI vendored templates provision a Postgres StatefulSet for the apps it
deploys (not for Superfield itself). These are the templates that `superfield init`
renders per environment:

| Template                                              | What it creates                                                                                |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `packages/core/templates/k8s/postgres.yaml.tpl`       | `StatefulSet` named `postgres-{{ ENV }}` — `postgres:16-alpine`, 20 Gi `local-path` PVC        |
| `packages/core/templates/k8s/db-migrate-job.yaml.tpl` | `Job` named `db-migrate-{{ ENV }}-{{ NAME_TAG }}` — runs `/app migrate` from the product image |
| `packages/core/templates/k8s/db-seed-job.yaml.tpl`    | `Job` named `db-seed-{{ ENV }}-{{ NAME_TAG }}` — runs `/app seed` from the product image       |

The migration job passes `DATABASE_URL` from a k8s secret (`app-{{ ENV }}`
key `database_url`). The actual migration logic is owned by the **product**
being deployed (the product's binary must implement `migrate` and `seed`
subcommands). Superfield only renders the Job manifests.

**Studio local dev:** `packages/control-core/secret-generator.ts` generates
ephemeral postgres credentials for each studio session. It detects
`DATABASE_URL`-pattern keys and generates `postgresql://<role>:<token>@superfield-postgres:5432/<db>`
strings. The seeding step (`seedApplicationData`) inserts dummy `worker_credentials`
rows via `kubectl exec` on the Postgres pod.

---

### 6. CLI — Cloud-managed DB provisioning

When `superfield init --managed-db` is used, the CLI can provision a managed
Postgres via the cloud provider:

| Provider     | Managed DB service                  | Version | How DATABASE_URL is derived                            |
| ------------ | ----------------------------------- | ------- | ------------------------------------------------------ |
| GCP          | AlloyDB (POSTGRES_15)               | Pg 15   | Private IP from AlloyDB instance; `app` user, `app` DB |
| AWS          | RDS (postgres engine, pg 16)        | Pg 16   | RDS endpoint hostname; `db.t3.micro`, `app` DB         |
| DigitalOcean | No managed DB; SSH pg_dump fallback | —       | Falls through to SSH export path                       |
| Vultr        | No managed DB; SSH pg_dump fallback | —       | Falls through to SSH export path                       |

Passwords are derived from the operator mnemonic via `derivePassword()` (not
stored anywhere except the GitHub Actions secret `DATABASE_URL_<ENV>`).

---

## Vector Columns Inventory

| Component | Table  | Column         | Dimension | Index                                           | Model                      |
| --------- | ------ | -------------- | --------- | ----------------------------------------------- | -------------------------- |
| Nexum     | blocks | embedding      | 384       | HNSW (cosine) — `blocks_embedding_hnsw_idx`     | `Xenova/all-MiniLM-L6-v2`  |
| Nexum     | links  | edge_embedding | 384       | HNSW (cosine) — `links_edge_embedding_hnsw_idx` | stub (Phase 2 / issue #75) |
| Sharp     | (none) | —              | —         | —                                               | —                          |
| CLI       | (none) | —              | —         | —                                               | —                          |

---

## AGE Second Instance — Detailed Findings

The second Postgres process is Nexum-only. Its current disposition:

- **Service:** `postgres-age` in `docker-compose.yml` — `apache/age:PG16_latest`, port 5433
- **DB name:** `nexum_age`; graph: `nexum_links`
- **Data written:** None in Phase 1. The scout stub created the graph/labels but no real edges are written yet.
- **Real writes land in:** Issue #75 (`writeAgeEdge()` in `src/db/age.ts` — already wired but only active when `AGE_DATABASE_URL` is set)
- **Architecture requirement:** Must be folded into the single Postgres instance. Apache AGE v1.5+ can run alongside pgvector in a standard Postgres build. A unified image (`pgvector` + `age` compiled together) would eliminate the second service.

**Risk:** AGE and pgvector are both Postgres extension `.so` files. The
`pgvector/pgvector:pg16` image does not include AGE; the `apache/age:PG16_latest`
image does not include pgvector. A custom image that includes both is required
before the two services can merge. No such image exists in the repo today.

---

## Integration Points and Risks

| Risk                                        | Severity | Details                                                                                                                                                                                                                              |
| ------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **No shared version table**                 | High     | Nexum uses file-level idempotency (`IF NOT EXISTS`); Sharp uses `schema_migrations`. A unified runner must pick one strategy.                                                                                                        |
| **Two Postgres services in Nexum**          | High     | AGE second service on :5433 violates the one-instance rule; folding it in requires a custom image with both extensions.                                                                                                              |
| **No pgvector in Sharp**                    | Low      | Sharp uses plain Postgres; adding pgvector later is an extension install + migration only.                                                                                                                                           |
| **Product migration is opaque**             | Medium   | The CLI renders a Job that runs `/app migrate`. The migration logic is inside the product binary, not inspectable from Superfield.                                                                                                   |
| **`migrate()` shim in CLI is a no-op**      | Low      | `packages/db/index.ts::migrate()` exists only for bootstrap compatibility; it does nothing. Callers that expect it to actually run a migration will be silently confused.                                                            |
| **AGE writes are inlined into `migrate()`** | Medium   | `migrate.ts::migrateAge()` is called at the end of `migrate()` (primary migration). If `AGE_DATABASE_URL` is set, AGE migrations run inside the same `migrate` invocation. With a unified runner this coupling needs to be explicit. |
| **No RLS anywhere**                         | Medium   | Architecture target includes workspace/tenant isolation; neither Nexum nor Sharp has any row-level security yet.                                                                                                                     |
| **`pg-container.ts` duplication**           | Low      | Two near-identical implementations: `packages/db/pg-container.ts` (unused) and `packages/control/tests/helpers/pg-container.ts` (used). Should be consolidated.                                                                      |

---

## Downstream Issues to Update

Issues that depend on this inventory:

- The unified migration runner issue (substrate foundations phase) should adopt Sharp's `schema_migrations` table approach (numbered files in transactions), applied to Nexum's schema with proper versioning.
- The AGE unification issue must include a custom Docker image build step to merge `pgvector` and `age` extensions before the second service can be removed.
- Nexum schema migration should be converted from idempotent-SQL to numbered migration files with `schema_migrations` tracking — compatible with the target runner design.

---

## Canonical Docs References

- `docs/architecture.md` — one binary, one Postgres instance constraint
- `docs/implementation-plan.md` — Substrate foundations phase
- `superfield-ai/nexum`: `db/schema.sql`, `db/migrations/0001_age_shim.sql`, `src/db/migrate.ts`, `src/db/age.ts`
- `superfield-ai/sharp`: `apps/server/migrations/*.sql`, `apps/server/src/migrate.ts`
