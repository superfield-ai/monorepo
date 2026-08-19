//! Integration proof for `docs/adr-nexum-storage-topology.md` (issue #890):
//! nexum's schema boots inside a database it does not own, under a dedicated
//! **scoped** role, with no reach into the consumer's own schemas.
//!
//! This is the executed evidence behind the ADR's §3 (schema coexistence under a
//! scoped Postgres role) and §4 (the `nexum.page_revisions` -> `public.workspaces`
//! tenancy anchor). The ADR makes a *negative* claim — "the nexum role holds no
//! privilege outside the `nexum` schema beyond two sanctioned read-only grants on
//! `public.workspaces`" — and negative claims rot silently. Compilation cannot
//! check one, and a hand-maintained grant list drifts the moment a migration adds
//! a table. So the claim is asserted here against a live Postgres instead.
//!
//! # What is simulated
//!
//! An **external consumer's own Postgres**: a freshly created database (not any
//! Superfield database) that already contains a consumer-owned schema
//! `consumer_app` with data in it. Nexum is provisioned into that database as a
//! guest exactly as the ADR §3 operator runbook specifies — a `NOSUPERUSER`,
//! `NOBYPASSRLS`, `NOCREATEDB`, `NOCREATEROLE` role owning only schema `nexum` —
//! and then boots through the caller-configured entry point the ADR §1 ratifies
//! (`DbConfig::from_url` + `connect`).
//!
//! # Loud-skip, never silent-skip
//!
//! These tests need a live Postgres. When `SF_DB_REQUIRE_DB` is set (as it is on
//! the CI job that runs them) and `DATABASE_URL` is absent, they **panic** rather
//! than skip, so a lost database surfaces as a red build instead of a false green.
//! See `docs/testing-invariants.md` and the `NEXUM_REQUIRE_DB` precedent in
//! `crates/nexum/tests/integration.rs`.
//!
//! The `DATABASE_URL` role must be able to `CREATE DATABASE` and `CREATE ROLE`
//! (it plays the consumer's administrator). CI's `pgvector/pgvector:pg16`
//! service superuser satisfies this.
//!
//! # CI wiring
//!
//! Selected by `scripts/rust-test-seam-filter.txt` into `.github/workflows/rust.yml`'s
//! `rust-test-seam` job, which runs `--run-ignored all --no-tests=fail` against a
//! `pgvector/pgvector:pg16` `services:` container — so the `#[ignore]` below is
//! *executed* in CI, not skipped. The attribute exists only to keep the test out
//! of the hermetic, database-free required `rust-test` job.
//!
//! Run locally against a live database:
//! ```bash
//! DATABASE_URL=postgres://... cargo test -p sf-db \
//!     --test external_nexum_scoped_role_integration -- --ignored --nocapture
//! ```

use sqlx::postgres::PgPoolOptions;
use sqlx::{Executor, PgPool, Row};

/// Env marker that turns "no database" from a skip into a hard failure.
const REQUIRE_DB_MARKER: &str = "SF_DB_REQUIRE_DB";

/// Password for the throwaway scoped role. Not a secret: the role exists only
/// for the lifetime of one test, against a throwaway database.
const SCOPED_ROLE_PASSWORD: &str = "nexum_ext_proof_pw";

/// The one cross-schema exception `docs/adr-nexum-storage-topology.md` §3
/// sanctions: read-only access to the tenancy anchor table.
const SANCTIONED_TABLE: (&str, &str) = ("public", "workspaces");
/// The only privilege types sanctioned on [`SANCTIONED_TABLE`]. Deliberately
/// excludes INSERT/UPDATE/DELETE: nexum reads tenants, it never manages them.
const SANCTIONED_PRIVILEGES: &[&str] = &["SELECT", "REFERENCES"];

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers (unit-tested below, so the loud-fail logic itself is covered by
// the hermetic required `rust-test` job rather than only by the DB-gated one).
// ─────────────────────────────────────────────────────────────────────────────

/// Whether the caller has declared that a database MUST be present.
fn db_is_required() -> bool {
    std::env::var(REQUIRE_DB_MARKER)
        .map(|v| !v.is_empty())
        .unwrap_or(false)
}

/// Resolve the admin database URL, refusing to skip when a database is required.
///
/// `Ok(Some(url))` — run. `Ok(None)` — no database and none demanded, skip.
/// `Err(msg)` — a database was demanded and is absent; the caller must panic.
fn resolve_db_url(database_url: Option<&str>, require_db: bool) -> Result<Option<String>, String> {
    match database_url {
        Some(url) if !url.is_empty() => Ok(Some(url.to_string())),
        _ if require_db => Err(format!(
            "{REQUIRE_DB_MARKER} is set but DATABASE_URL is absent: the external-Postgres \
             scoped-role proof for docs/adr-nexum-storage-topology.md must run against a live \
             database. Refusing to skip silently — provision DATABASE_URL or unset \
             {REQUIRE_DB_MARKER}."
        )),
        _ => Ok(None),
    }
}

/// Rewrite an admin connection URL to point at `db` as `role`.
///
/// Keeps the admin URL's host and port (the only parts that describe *where*
/// the server is) and replaces the credentials and database name. Any query
/// string on the admin URL (e.g. `?sslmode=require`) is preserved so TLS
/// settings survive.
fn scoped_url(admin_url: &str, role: &str, password: &str, db: &str) -> String {
    let after_scheme = admin_url
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(admin_url);
    // Credentials may contain '@' (percent-encoded or not); the authority is
    // whatever follows the LAST '@'.
    let authority = after_scheme
        .rsplit_once('@')
        .map(|(_, rest)| rest)
        .unwrap_or(after_scheme);
    let host_port = authority
        .split(['/', '?'])
        .next()
        .unwrap_or(authority)
        .to_string();
    let query = admin_url
        .split_once('?')
        .map(|(_, q)| format!("?{q}"))
        .unwrap_or_default();
    format!("postgres://{role}:{password}@{host_port}/{db}{query}")
}

/// True iff a grant row falls inside the privilege envelope the ADR sanctions.
fn grant_is_sanctioned(schema: &str, table: &str, privilege: &str) -> bool {
    if schema == "nexum" {
        return true;
    }
    (schema, table) == SANCTIONED_TABLE && SANCTIONED_PRIVILEGES.contains(&privilege)
}

// ─────────────────────────────────────────────────────────────────────────────
// Live-database harness
// ─────────────────────────────────────────────────────────────────────────────

/// A provisioned stand-in for an external consumer's Postgres.
struct ExternalDeployment {
    /// Superuser pool on the ORIGINAL (maintenance) database — used to create
    /// and later drop the throwaway database and role.
    admin: PgPool,
    /// Superuser pool on the throwaway consumer database — the operator.
    consumer_admin: PgPool,
    /// The confined nexum role's own pool on the consumer database.
    scoped: PgPool,
    db_name: String,
    role_name: String,
}

/// Connect the admin pool, or decide to skip (loudly, when a DB is required).
async fn admin_pool_or_skip() -> Option<(PgPool, String)> {
    let raw = std::env::var("DATABASE_URL").ok();
    let url = match resolve_db_url(raw.as_deref(), db_is_required()) {
        Ok(Some(url)) => url,
        Ok(None) => {
            eprintln!(
                "skipping external_nexum_scoped_role_integration: DATABASE_URL not set \
                 (set {REQUIRE_DB_MARKER}=1 to make this a hard failure)"
            );
            return None;
        }
        Err(msg) => panic!("{msg}"),
    };

    let pool = PgPoolOptions::new()
        .max_connections(2)
        .connect(&url)
        .await
        .expect("connect admin pool to DATABASE_URL");
    Some((pool, url))
}

/// Stand up a fresh "consumer" database and provision nexum into it exactly as
/// `docs/adr-nexum-storage-topology.md` §3 specifies — no extra privileges.
async fn provision_external_deployment(tag: &str) -> Option<ExternalDeployment> {
    let (admin, admin_url) = admin_pool_or_skip().await?;

    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let db_name = format!("nexum_ext_{tag}_{suffix}");
    let role_name = format!("nexum_app_{tag}_{suffix}");

    // ── Operator step 1: the confined role. ──────────────────────────────────
    // NOSUPERUSER + NOBYPASSRLS are what make the coexistence claim meaningful:
    // a superuser bypasses every privilege check and every RLS policy the
    // consumer applies to its own tables.
    admin
        .execute(
            format!(
                "CREATE ROLE {role_name} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE \
                 PASSWORD '{SCOPED_ROLE_PASSWORD}'"
            )
            .as_str(),
        )
        .await
        .expect("create scoped nexum role");

    // The consumer's own database. Owned by the administrator, NOT by the nexum
    // role — nexum is a guest, so it inherits no implicit authority.
    admin
        .execute(format!("CREATE DATABASE {db_name}").as_str())
        .await
        .expect("create throwaway external consumer database");

    let consumer_admin_url = scoped_url(
        &admin_url,
        // Reuse the admin credentials, only swapping the database.
        &admin_username(&admin_url),
        &admin_password(&admin_url),
        &db_name,
    );
    let consumer_admin = PgPoolOptions::new()
        .max_connections(2)
        .connect(&consumer_admin_url)
        .await
        .expect("connect administrator pool to the consumer database");

    // ── The consumer's own pre-existing data, created BEFORE nexum boots. ────
    // This is what nexum must never be able to reach.
    for stmt in [
        "CREATE SCHEMA consumer_app",
        "CREATE TABLE consumer_app.customers (id INT PRIMARY KEY, secret TEXT NOT NULL)",
        "INSERT INTO consumer_app.customers (id, secret) VALUES (1, 'consumer-only')",
    ] {
        consumer_admin
            .execute(stmt)
            .await
            .expect("seed consumer-owned schema");
    }

    // ── Operator step 2: extensions, installed by the administrator. ─────────
    // nexum/0001 issues `CREATE EXTENSION IF NOT EXISTS`, which is a NOTICE (not
    // an error) once present — so the confined role never needs the privilege to
    // install one. That is precisely what makes ADR §3 workable.
    for stmt in [
        r#"CREATE EXTENSION IF NOT EXISTS "pgcrypto""#,
        r#"CREATE EXTENSION IF NOT EXISTS "vector""#,
    ] {
        consumer_admin
            .execute(stmt)
            .await
            .expect("install required extension as administrator");
    }

    // ── Operator step 3: the nexum schema, owned by the confined role. ───────
    // Pre-creating it means the role never needs CREATE on the database.
    consumer_admin
        .execute(format!("CREATE SCHEMA nexum AUTHORIZATION {role_name}").as_str())
        .await
        .expect("create nexum schema owned by the scoped role");

    // ── Operator step 4: the tenancy anchor + its two sanctioned grants. ─────
    // public.workspaces comes from sf-db's own 0001 migration, applied verbatim
    // by the administrator (ADR §4): the external consumer supplies the anchor,
    // nexum only references it.
    let workspaces_sql = tenancy_anchor_sql();
    consumer_admin
        .execute(workspaces_sql.as_str())
        .await
        .expect("apply the public.workspaces tenancy anchor as administrator");

    for stmt in [
        format!("GRANT CONNECT ON DATABASE {db_name} TO {role_name}"),
        // CREATE on the database is required even though the schema already
        // exists: PostgreSQL's CreateSchemaCommand performs the database-level
        // ACL check BEFORE the `IF NOT EXISTS` short-circuit, so nexum/0001's
        // `CREATE SCHEMA IF NOT EXISTS nexum` is refused without it. This is a
        // privilege to create NEW schemas — it confers nothing on schemas that
        // already exist, as the consumer_app assertions below prove.
        format!("GRANT CREATE ON DATABASE {db_name} TO {role_name}"),
        format!("GRANT USAGE ON SCHEMA public TO {role_name}"),
        format!("GRANT SELECT, REFERENCES ON public.workspaces TO {role_name}"),
    ] {
        consumer_admin
            .execute(stmt.as_str())
            .await
            .expect("apply sanctioned grant");
    }

    // ── Operator step 5: keep the migration ledger inside the nexum schema. ──
    // `apply_migrations` creates an UNQUALIFIED `schema_migrations`, so without
    // this the runner would try to write into the consumer's `public` schema.
    consumer_admin
        .execute(
            format!("ALTER ROLE {role_name} IN DATABASE {db_name} SET search_path = nexum, public")
                .as_str(),
        )
        .await
        .expect("pin the scoped role's search_path");

    // ── Boot nexum through the caller-configured entry point (ADR §1). ───────
    let url = scoped_url(&admin_url, &role_name, SCOPED_ROLE_PASSWORD, &db_name);
    let cfg = sf_db::DbConfig::from_url(&url).expect("DbConfig::from_url accepts the scoped URL");
    let scoped = sf_db::connect(&cfg)
        .await
        .expect("connect as the scoped nexum role");

    Some(ExternalDeployment {
        admin,
        consumer_admin,
        scoped,
        db_name,
        role_name,
    })
}

async fn teardown(d: ExternalDeployment) {
    d.scoped.close().await;
    d.consumer_admin.close().await;
    // FORCE terminates any lingering backend so the drop cannot hang.
    let _ = d
        .admin
        .execute(format!("DROP DATABASE IF EXISTS {} WITH (FORCE)", d.db_name).as_str())
        .await;
    let _ = d
        .admin
        .execute(format!("DROP ROLE IF EXISTS {}", d.role_name).as_str())
        .await;
    d.admin.close().await;
}

/// The username embedded in the admin URL.
fn admin_username(admin_url: &str) -> String {
    userinfo(admin_url)
        .and_then(|ui| ui.split_once(':').map(|(u, _)| u.to_string()))
        .or_else(|| userinfo(admin_url))
        .unwrap_or_else(|| "postgres".to_string())
}

/// The password embedded in the admin URL.
fn admin_password(admin_url: &str) -> String {
    userinfo(admin_url)
        .and_then(|ui| ui.split_once(':').map(|(_, p)| p.to_string()))
        .unwrap_or_default()
}

fn userinfo(admin_url: &str) -> Option<String> {
    let after_scheme = admin_url
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(admin_url);
    after_scheme
        .rsplit_once('@')
        .map(|(ui, _)| ui.to_string())
        .filter(|ui| !ui.is_empty())
}

/// nexum's own migrations, in apply order.
fn nexum_migrations() -> Vec<sf_db::Migration> {
    let all = sf_db::discover_migrations(&sf_db::repo_root()).expect("discover migrations");
    let mine: Vec<sf_db::Migration> = all
        .into_iter()
        .filter(|m| m.id.starts_with("nexum/"))
        .collect();
    assert!(
        !mine.is_empty(),
        "no nexum migrations discovered — the proof would vacuously pass"
    );
    mine
}

/// The tenancy-anchor SQL (`public.workspaces`), read from sf-db's own 0001
/// migration so this test can never drift from the real table definition.
fn tenancy_anchor_sql() -> String {
    let all = sf_db::discover_migrations(&sf_db::repo_root()).expect("discover migrations");
    all.into_iter()
        .find(|m| m.id == "sf-db/0001_workspaces")
        .expect("sf-db/0001_workspaces must exist — it defines the tenancy anchor")
        .sql
}

// ─────────────────────────────────────────────────────────────────────────────
// AC2: nexum's migrations apply against an external database under a dedicated,
//      non-superuser, NOBYPASSRLS role.
// ─────────────────────────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: requires DATABASE_URL with CREATE DATABASE/CREATE ROLE rights"]
async fn nexum_migrations_apply_against_external_database_under_scoped_role() {
    let Some(d) = provision_external_deployment("boot").await else {
        return;
    };

    // The role really is confined (a superuser would make every later assertion
    // vacuous).
    let attrs = sqlx::query(
        "SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole \
         FROM pg_roles WHERE rolname = current_user",
    )
    .fetch_one(&d.scoped)
    .await
    .expect("read the connected role's attributes");
    for (col, label) in [
        ("rolsuper", "SUPERUSER"),
        ("rolbypassrls", "BYPASSRLS"),
        ("rolcreatedb", "CREATEDB"),
        ("rolcreaterole", "CREATEROLE"),
    ] {
        assert!(
            !attrs.get::<bool, _>(col),
            "the nexum role must not hold {label} (ADR §3)"
        );
    }

    let current_user: String = sqlx::query_scalar("SELECT current_user")
        .fetch_one(&d.scoped)
        .await
        .expect("read current_user");
    assert_eq!(
        current_user, d.role_name,
        "migrations must be applied AS the scoped role, not as the administrator"
    );

    // ── The claim under test: nexum boots and migrates as a guest. ───────────
    let migs = nexum_migrations();
    let applied = sf_db::apply_migrations(&d.scoped, &migs)
        .await
        .expect("nexum migrations must apply against an external database under the scoped role");

    let expected: Vec<String> = migs.iter().map(|m| m.id.clone()).collect();
    assert_eq!(
        applied, expected,
        "every nexum migration must apply, in order, on a fresh external database"
    );

    // The schema really materialised.
    for table in ["corpora", "blocks", "links", "project_nodes", "page_revisions"] {
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM information_schema.tables \
             WHERE table_schema = 'nexum' AND table_name = $1)",
        )
        .bind(table)
        .fetch_one(&d.scoped)
        .await
        .expect("query information_schema.tables");
        assert!(exists, "nexum.{table} must exist after migration");
    }

    // ADR §4: the page_revisions -> public.workspaces FK survived, so tenancy is
    // database-enforced in the external topology too.
    let fk_exists: bool = sqlx::query_scalar(
        "SELECT EXISTS ( \
            SELECT 1 FROM pg_constraint c \
            JOIN pg_class child  ON child.oid  = c.conrelid \
            JOIN pg_namespace cn ON cn.oid     = child.relnamespace \
            JOIN pg_class par    ON par.oid    = c.confrelid \
            JOIN pg_namespace pn ON pn.oid     = par.relnamespace \
            WHERE c.contype = 'f' \
              AND cn.nspname = 'nexum' AND child.relname = 'page_revisions' \
              AND pn.nspname = 'public' AND par.relname  = 'workspaces')",
    )
    .fetch_one(&d.scoped)
    .await
    .expect("query pg_constraint");
    assert!(
        fk_exists,
        "nexum.page_revisions must still FK to public.workspaces externally (ADR §4)"
    );

    // ADR §3 step 5: the ledger landed in `nexum`, never in the consumer's `public`.
    let ledger_schema: Option<String> = sqlx::query_scalar(
        "SELECT table_schema::text FROM information_schema.tables \
         WHERE table_name = 'schema_migrations'",
    )
    .fetch_optional(&d.scoped)
    .await
    .expect("locate schema_migrations");
    assert_eq!(
        ledger_schema.as_deref(),
        Some("nexum"),
        "the migration ledger must live in the nexum schema, not the consumer's public schema"
    );

    // Idempotent re-run: a restarting container must not re-apply anything.
    let again = sf_db::apply_migrations(&d.scoped, &migs)
        .await
        .expect("re-running migrations must succeed");
    assert!(
        again.is_empty(),
        "second migration run must apply nothing, got {again:?}"
    );

    teardown(d).await;
}

// ─────────────────────────────────────────────────────────────────────────────
// AC3: the scoped role holds no grants outside the nexum schema, beyond the
//      narrow exception the ADR explicitly sanctions.
// ─────────────────────────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
#[ignore = "integration: requires DATABASE_URL with CREATE DATABASE/CREATE ROLE rights"]
async fn scoped_external_role_holds_no_grants_outside_nexum_schema() {
    let Some(d) = provision_external_deployment("grants").await else {
        return;
    };

    // Migrate first: the envelope must hold AFTER nexum has created its tables,
    // which is when a careless migration would have widened it.
    let migs = nexum_migrations();
    sf_db::apply_migrations(&d.scoped, &migs)
        .await
        .expect("apply nexum migrations");

    // ── Enumerate every table grant the role actually holds. ────────────────
    // Queried AS the role: information_schema.role_table_grants is filtered by
    // the querying session's enabled roles, so asking as the role itself is the
    // only way to get its complete, authoritative grant set.
    let rows = sqlx::query(
        "SELECT table_schema::text AS s, table_name::text AS t, privilege_type::text AS p \
         FROM information_schema.role_table_grants \
         WHERE grantee = current_user \
         ORDER BY 1, 2, 3",
    )
    .fetch_all(&d.scoped)
    .await
    .expect("enumerate role_table_grants");

    assert!(
        !rows.is_empty(),
        "the role must hold SOME grants (it owns the nexum tables) — an empty result \
         would mean the query is wrong and the assertion below is vacuous"
    );

    let mut out_of_envelope = Vec::new();
    let mut saw_nexum_table = false;
    let mut sanctioned_seen: Vec<String> = Vec::new();
    for row in &rows {
        let schema: String = row.get("s");
        let table: String = row.get("t");
        let privilege: String = row.get("p");
        if schema == "nexum" {
            saw_nexum_table = true;
        }
        if (schema.as_str(), table.as_str()) == SANCTIONED_TABLE {
            sanctioned_seen.push(privilege.clone());
        }
        if !grant_is_sanctioned(&schema, &table, &privilege) {
            out_of_envelope.push(format!("{schema}.{table}:{privilege}"));
        }
    }

    assert!(
        out_of_envelope.is_empty(),
        "the scoped nexum role holds grants outside the envelope sanctioned by \
         docs/adr-nexum-storage-topology.md §3: {out_of_envelope:?}"
    );
    assert!(
        saw_nexum_table,
        "the role must hold grants on its own nexum tables"
    );
    sanctioned_seen.sort();
    assert_eq!(
        sanctioned_seen,
        vec!["REFERENCES".to_string(), "SELECT".to_string()],
        "public.workspaces must carry EXACTLY the sanctioned read-only grants — no write \
         privilege on the tenancy anchor"
    );

    // ── Schema-level cross-check via has_schema_privilege (ADR §3). ──────────
    let role = &d.role_name;
    let privs = sqlx::query(&format!(
        "SELECT has_schema_privilege('{role}', 'nexum', 'USAGE')        AS nexum_usage, \
                has_schema_privilege('{role}', 'nexum', 'CREATE')       AS nexum_create, \
                has_schema_privilege('{role}', 'public', 'USAGE')       AS public_usage, \
                has_schema_privilege('{role}', 'public', 'CREATE')      AS public_create, \
                has_schema_privilege('{role}', 'consumer_app', 'USAGE') AS consumer_usage"
    ))
    .fetch_one(&d.consumer_admin)
    .await
    .expect("query has_schema_privilege");

    assert!(
        privs.get::<bool, _>("nexum_usage") && privs.get::<bool, _>("nexum_create"),
        "the role must own its own nexum schema"
    );
    assert!(
        privs.get::<bool, _>("public_usage"),
        "USAGE on public is sanctioned — it is needed to resolve public.workspaces"
    );
    assert!(
        !privs.get::<bool, _>("public_create"),
        "the role must NOT be able to create objects in the consumer's public schema (ADR §3)"
    );
    assert!(
        !privs.get::<bool, _>("consumer_usage"),
        "the role must have NO access to the consumer's own schema (ADR §3)"
    );

    // Database-level envelope. CREATE is present by necessity (nexum/0001 issues
    // `CREATE SCHEMA IF NOT EXISTS`, and PostgreSQL checks the database ACL
    // before the IF-NOT-EXISTS short-circuit). This pins that it buys the role
    // nothing on the consumer's existing schemas — the assertion above.
    let db = &d.db_name;
    let db_privs = sqlx::query(&format!(
        "SELECT has_database_privilege('{role}', '{db}', 'CONNECT') AS conn, \
                has_database_privilege('{role}', '{db}', 'CREATE')  AS create_"
    ))
    .fetch_one(&d.consumer_admin)
    .await
    .expect("query has_database_privilege");
    assert!(
        db_privs.get::<bool, _>("conn") && db_privs.get::<bool, _>("create_"),
        "the sanctioned database-level envelope is CONNECT + CREATE (ADR §3)"
    );

    // ── The behavioural proof: the consumer's data is actually refused. ──────
    let denied = sqlx::query("SELECT secret FROM consumer_app.customers")
        .fetch_all(&d.scoped)
        .await;
    let err = denied.expect_err(
        "the scoped nexum role must be REFUSED when reading the consumer's own table",
    );
    let msg = err.to_string();
    assert!(
        msg.contains("permission denied"),
        "expected a permission-denied error reading consumer_app.customers, got: {msg}"
    );

    // And it cannot plant objects in the consumer's default namespace.
    let create_denied = d
        .scoped
        .execute("CREATE TABLE public.nexum_squatter (id INT)")
        .await;
    assert!(
        create_denied.is_err(),
        "the scoped nexum role must not be able to create tables in public (ADR §3)"
    );

    teardown(d).await;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure unit tests — these run in the hermetic, database-free required job, so
// the loud-fail contract itself is covered even where no Postgres exists.
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod unit {
    use super::*;

    #[test]
    fn resolve_db_url_returns_the_url_when_present() {
        let got = resolve_db_url(Some("postgres://u:p@h:5432/db"), true);
        assert_eq!(got, Ok(Some("postgres://u:p@h:5432/db".to_string())));
    }

    #[test]
    fn resolve_db_url_errors_when_required_and_absent() {
        let err = resolve_db_url(None, true).expect_err("must refuse to skip");
        assert!(err.contains(REQUIRE_DB_MARKER));
        // An empty DATABASE_URL is "absent", not "a valid empty target".
        assert!(resolve_db_url(Some(""), true).is_err());
    }

    #[test]
    fn resolve_db_url_skips_only_when_not_required() {
        assert_eq!(resolve_db_url(None, false), Ok(None));
        assert_eq!(resolve_db_url(Some(""), false), Ok(None));
    }

    #[test]
    fn scoped_url_swaps_credentials_and_database_keeping_host() {
        assert_eq!(
            scoped_url(
                "postgres://superfield:superfield@postgres:5432/superfield",
                "nexum_app",
                "pw",
                "consumer",
            ),
            "postgres://nexum_app:pw@postgres:5432/consumer"
        );
    }

    #[test]
    fn scoped_url_preserves_query_string_and_tolerates_at_in_password() {
        assert_eq!(
            scoped_url(
                "postgresql://admin:p@ss@db.internal:6432/maintenance?sslmode=require",
                "nexum_app",
                "pw",
                "consumer",
            ),
            "postgres://nexum_app:pw@db.internal:6432/consumer?sslmode=require"
        );
    }

    #[test]
    fn grant_envelope_admits_nexum_and_the_sanctioned_anchor_only() {
        assert!(grant_is_sanctioned("nexum", "blocks", "DELETE"));
        assert!(grant_is_sanctioned("public", "workspaces", "SELECT"));
        assert!(grant_is_sanctioned("public", "workspaces", "REFERENCES"));
        // Write access to the tenancy anchor is NOT sanctioned.
        assert!(!grant_is_sanctioned("public", "workspaces", "INSERT"));
        // Nothing else in public, and nothing at all in a consumer schema.
        assert!(!grant_is_sanctioned("public", "billing", "SELECT"));
        assert!(!grant_is_sanctioned("consumer_app", "customers", "SELECT"));
    }
}
