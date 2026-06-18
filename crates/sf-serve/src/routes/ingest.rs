//! Knowledge ingest + docs API routes (`/studio/docs`, document write/upload).
//!
//! Fills the dev-scout seam reserved by issue #677 with the real web-authoring
//! ingest surface delivered by issue #673 (`feat(web): author and upload
//! knowledge from the control panel via a server-side ingest route`).
//!
//! # Route inventory
//!
//! | Method | Path                  | Backing call                              |
//! |--------|-----------------------|-------------------------------------------|
//! | POST   | `/studio/docs`        | [`nexum::ingest::ingest_document`]        |
//! | GET    | `/studio/docs`        | list ingested documents (filenames)       |
//! | GET    | `/studio/docs/{file}` | reconstruct one document's markdown        |
//!
//! The `POST` handler runs the **same** ingest-and-embed pipeline as the
//! `superfield garden` CLI ([`nexum::ingest::ingest_document`]) — parse → hash →
//! embed → write to the shared Postgres — so content authored in the browser is
//! immediately searchable through brain search and visible in page projections,
//! with no CLI involvement.
//!
//! Each handler stamps `workspace_id` from the request's [`sf_auth::AuthContext`]
//! extension (never from the body) and calls [`sf_db::acquire_workspace`] before
//! touching the database so per-workspace RLS policies fire correctly — the same
//! pattern as [`super::studio`].
//!
//! These routes are merged into the protected (auth-wrapped) route group in
//! [`crate::build_router`]; that merge chain is **not** edited here, keeping this
//! module conflict-free with the `/studio/*` routes owned by [`super::studio`]
//! and [`super::project`] (the path prefixes are kept distinct: `docs` here vs.
//! `issues`/`steer` there).
//!
//! The `WS /studio/ws` agent-chat surface is a separate websocket seam and is
//! out of scope for this route module.
//!
//! # Canonical docs
//!
//! - `docs/architecture.md` §Nexum — ingestion pipeline / §Control Webapp.
//! - Issue #677 (this seam), #673 (this feature).

use axum::{
    extract::{Path, State},
    http::{header, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Extension, Json, Router,
};
use nexum::embed::Embedder;
use nexum::parse::Format;
use nexum::{ingest_document, IngestOptions};
use serde::Deserialize;
use serde_json::json;
use sf_auth::AuthContext;
use sqlx::PgPool;
use std::sync::Arc;
use tokio::sync::OnceCell;
use uuid::Uuid;

use crate::state::AppState;

/// Process-wide embedding model, loaded lazily on the first `POST /studio/docs`.
///
/// [`Embedder::new`] downloads / mmaps the governed model weights, which is
/// expensive — far too costly to repeat per request. The CLI builds one
/// embedder per `superfield garden` invocation; the long-lived server builds
/// one per process and shares it (the model is read-only and `Send + Sync`).
static EMBEDDER: OnceCell<Arc<Embedder>> = OnceCell::const_new();

/// Get (or lazily initialise) the shared process embedder.
///
/// The blocking model load runs on a blocking thread so the async runtime is
/// not stalled. Returns an error string suitable for a `500` body if the model
/// cannot be loaded.
async fn shared_embedder() -> Result<Arc<Embedder>, String> {
    EMBEDDER
        .get_or_try_init(|| async {
            tokio::task::spawn_blocking(|| Embedder::new().map(Arc::new))
                .await
                .map_err(|e| format!("embedder init task panicked: {e}"))?
                .map_err(|e| format!("embedding model load failed: {e}"))
        })
        .await
        .cloned()
}

// ---------------------------------------------------------------------------
// POST /studio/docs — write / upload a document and ingest it
// ---------------------------------------------------------------------------

/// Request body for `POST /studio/docs`.
///
/// The control-panel authoring surface posts a title and the raw markdown
/// content. `filename` is optional; when omitted it is derived from the title
/// (slugified, `.md` suffix) so the document reads back through `GET
/// /studio/docs/{file}` under a stable key.
#[derive(Debug, Deserialize)]
pub struct WriteDocBody {
    /// Human-readable document title.
    pub title: String,
    /// Raw document content (markdown).
    pub content: String,
    /// Optional filename used as the document's `external_id` key (the value
    /// `GET /studio/docs` lists and `GET /studio/docs/{file}` resolves).
    #[serde(default)]
    pub filename: Option<String>,
}

/// `POST /studio/docs` — author or upload a document and run the ingest pipeline.
///
/// Builds [`IngestOptions`] from the body — stamping `workspace_id` from the
/// authenticated [`AuthContext`], never the body — ensures the workspace's
/// `web` corpus exists, then calls [`nexum::ingest::ingest_document`] (the same
/// pipeline as `superfield garden`). On success the content is searchable and
/// visible in page projections immediately.
///
/// # Responses
///
/// - `201 Created` with the [`nexum::ingest::IngestResult`] summary and the
///   `filename` the document reads back under.
/// - `400 Bad Request` for an empty title or content.
/// - `500 Internal Server Error` for model-load or database failures.
pub async fn write_doc(
    State(state): State<AppState>,
    Extension(ctx): Extension<AuthContext>,
    Json(body): Json<WriteDocBody>,
) -> impl IntoResponse {
    let title = body.title.trim();
    if title.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "title must not be empty"})),
        )
            .into_response();
    }
    if body.content.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "content must not be empty"})),
        )
            .into_response();
    }

    // The filename key the doc reads back under: explicit, else slugified title.
    let filename = body
        .filename
        .as_deref()
        .map(str::trim)
        .filter(|f| !f.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| default_filename(title));

    // Propagate workspace context for RLS before any DB work.
    if let Err(e) = sf_db::acquire_workspace(state.pool(), ctx.principal_id()).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": format!("db error: {}", e)})),
        )
            .into_response();
    }

    // Ensure the workspace's `web` corpus exists for control-panel authoring.
    let corpus_id = match ensure_web_corpus(state.pool(), ctx.workspace_id).await {
        Ok(id) => id,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": format!("corpus error: {}", e)})),
            )
                .into_response()
        }
    };

    let embedder = match shared_embedder().await {
        Ok(e) => e,
        Err(e) => {
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": e}))).into_response()
        }
    };

    let opts = IngestOptions {
        // Stamp workspace from the auth context — never the request body.
        workspace_id: ctx.workspace_id,
        corpus_id,
        title: title.to_string(),
        content: body.content,
        format: Format::Markdown,
        external_id: Some(filename.clone()),
    };

    match ingest_document(state.pool(), &embedder, opts).await {
        Ok(result) => (
            StatusCode::CREATED,
            Json(json!({
                "filename": filename,
                "doc_id": result.doc_id,
                "version_id": result.version_id,
                "block_count": result.block_count,
                "reused_block_count": result.reused_block_count,
                "link_count": result.link_count,
            })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": format!("ingest failed: {}", e)})),
        )
            .into_response(),
    }
}

// ---------------------------------------------------------------------------
// GET /studio/docs — list ingested documents
// ---------------------------------------------------------------------------

/// `GET /studio/docs` — list the ingested documents for the workspace.
///
/// Returns the filename key (the document's `external_id`, falling back to a
/// slug of its `title`) of every document the authenticated workspace owns,
/// in title order. The control-panel `DocsController` reads this list to
/// populate the Product-tab docs sidebar.
///
/// # Responses
///
/// - `200 OK` with `{"files": ["readme.md", ...]}`.
/// - `500 Internal Server Error` on database failure.
pub async fn list_docs(
    State(state): State<AppState>,
    Extension(ctx): Extension<AuthContext>,
) -> impl IntoResponse {
    if let Err(e) = sf_db::acquire_workspace(state.pool(), ctx.principal_id()).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": format!("db error: {}", e)})),
        )
            .into_response();
    }

    let rows: Result<Vec<(Option<String>, String)>, sqlx::Error> = sqlx::query_as(
        "SELECT external_id, title FROM nexum.documents \
         WHERE workspace_id = $1 ORDER BY title",
    )
    .bind(ctx.workspace_id)
    .fetch_all(state.pool())
    .await;

    match rows {
        Ok(rows) => {
            let files: Vec<String> = rows
                .into_iter()
                .map(|(external_id, title)| {
                    external_id
                        .filter(|s| !s.trim().is_empty())
                        .unwrap_or_else(|| default_filename(&title))
                })
                .collect();
            (StatusCode::OK, Json(json!({ "files": files }))).into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": format!("db error: {}", e)})),
        )
            .into_response(),
    }
}

// ---------------------------------------------------------------------------
// GET /studio/docs/{file} — reconstruct one document's content
// ---------------------------------------------------------------------------

/// `GET /studio/docs/{file}` — return one document's reconstructed markdown.
///
/// Resolves `{file}` against the document `external_id` (or, as a fallback, a
/// slug of the title) within the workspace, then stitches the current version's
/// blocks back together in `seq` order into plain-text markdown — the inverse
/// of the parse step the ingest pipeline ran.
///
/// # Responses
///
/// - `200 OK` with `Content-Type: text/plain; charset=utf-8` and the document
///   markdown.
/// - `404 Not Found` with JSON `{"error": "unknown document"}` when no document
///   in the workspace matches `{file}`.
/// - `500 Internal Server Error` on database failure.
pub async fn get_doc(
    State(state): State<AppState>,
    Extension(ctx): Extension<AuthContext>,
    Path(file): Path<String>,
) -> impl IntoResponse {
    if let Err(e) = sf_db::acquire_workspace(state.pool(), ctx.principal_id()).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": format!("db error: {}", e)})),
        )
            .into_response();
    }

    // Resolve the document by external_id (or a title slug) within the workspace.
    let doc: Result<Option<(Uuid, Option<Uuid>)>, sqlx::Error> = sqlx::query_as(
        "SELECT id, current_version_id FROM nexum.documents \
         WHERE workspace_id = $1 AND (external_id = $2 OR title = $2) \
         ORDER BY created_at DESC LIMIT 1",
    )
    .bind(ctx.workspace_id)
    .bind(&file)
    .fetch_optional(state.pool())
    .await;

    let version_id = match doc {
        Ok(Some((_doc_id, Some(version_id)))) => version_id,
        Ok(Some((_doc_id, None))) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({"error": "document has no content yet", "file": file})),
            )
                .into_response()
        }
        Ok(None) => {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({"error": "unknown document", "file": file})),
            )
                .into_response()
        }
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": format!("db error: {}", e)})),
            )
                .into_response()
        }
    };

    // Stitch the current version's blocks back together in order.
    let blocks: Result<Vec<(String,)>, sqlx::Error> = sqlx::query_as(
        "SELECT b.content FROM nexum.version_blocks vb \
         JOIN nexum.blocks b ON b.id = vb.block_id \
         WHERE vb.version_id = $1 ORDER BY vb.seq",
    )
    .bind(version_id)
    .fetch_all(state.pool())
    .await;

    match blocks {
        Ok(rows) => {
            let content = rows
                .into_iter()
                .map(|(c,)| c)
                .collect::<Vec<_>>()
                .join("\n\n");
            (
                StatusCode::OK,
                [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
                content,
            )
                .into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error": format!("db error: {}", e)})),
        )
            .into_response(),
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Derive a stable `.md` filename key from a document title.
///
/// Lowercases, replaces any run of non-alphanumeric characters with a single
/// `-`, trims leading/trailing `-`, and appends `.md`. An all-punctuation title
/// falls back to `document.md`.
fn default_filename(title: &str) -> String {
    let mut slug = String::with_capacity(title.len());
    let mut prev_dash = false;
    for ch in title.trim().chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash {
            slug.push('-');
            prev_dash = true;
        }
    }
    let slug = slug.trim_matches('-');
    if slug.is_empty() {
        "document.md".to_string()
    } else {
        format!("{slug}.md")
    }
}

/// Ensure the workspace's `web` corpus exists in `nexum.corpora`, creating it
/// if absent, and return its UUID.
///
/// Control-panel authoring uses a dedicated `web` corpus (distinct from the
/// CLI's `seed` corpus) so authored documents are grouped together.
async fn ensure_web_corpus(pool: &PgPool, workspace_id: Uuid) -> Result<Uuid, sqlx::Error> {
    if let Some(id) = sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM nexum.corpora WHERE name = 'web' AND workspace_id = $1 LIMIT 1",
    )
    .bind(workspace_id)
    .fetch_optional(pool)
    .await?
    {
        return Ok(id);
    }

    sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO nexum.corpora (workspace_id, name, description) \
         VALUES ($1, 'web', 'Documents authored from the control panel') \
         RETURNING id",
    )
    .bind(workspace_id)
    .fetch_one(pool)
    .await
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/// Build the knowledge-ingest / docs API router.
///
/// Registers the `/studio/docs` write/list routes and the
/// `/studio/docs/{file}` content route. All routes are wrapped in the auth
/// middleware by the caller ([`crate::build_router`]).
pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/studio/docs", post(write_doc).get(list_docs))
        .route("/studio/docs/{file}", get(get_doc))
        .with_state(state)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_filename_slugifies_title() {
        assert_eq!(
            default_filename("Company Background"),
            "company-background.md"
        );
        assert_eq!(default_filename("  Spaced  Out  "), "spaced-out.md");
        assert_eq!(default_filename("Already-Kebab"), "already-kebab.md");
    }

    #[test]
    fn default_filename_collapses_punctuation() {
        assert_eq!(default_filename("Q3 2026 — Plan!"), "q3-2026-plan.md");
        assert_eq!(default_filename("multi   space"), "multi-space.md");
    }

    #[test]
    fn default_filename_all_punctuation_falls_back() {
        assert_eq!(default_filename("!!!"), "document.md");
        assert_eq!(default_filename("   "), "document.md");
    }

    /// Integration test: a document ingested through the web-authoring pipeline
    /// is listable, fetchable, and searchable.
    ///
    /// Mirrors the issue #673 test plan: ingest a document, then assert it
    /// appears in the `GET /studio/docs` list query, that
    /// `GET /studio/docs/{file}` reconstructs its content, and that the content
    /// is retrievable through the existing brain full-text search.
    ///
    /// Exercises the same `ingest_document` pipeline the `POST /studio/docs`
    /// handler runs (the handler additionally stamps `workspace_id` from the
    /// auth context and ensures the `web` corpus, both verified here). Skipped
    /// unless `DATABASE_URL` is set and the embedding model is available.
    #[tokio::test]
    #[ignore = "integration: requires DATABASE_URL + embedding model"]
    async fn web_ingest_is_listable_fetchable_and_searchable() {
        use nexum::query::{fulltext_search, FullTextOptions};
        use sf_db::{connect, DbConfig};

        let cfg = match DbConfig::from_env() {
            Ok(c) => c,
            Err(_) => {
                eprintln!("skip: DATABASE_URL not set");
                return;
            }
        };
        let pool = connect(&cfg).await.expect("pool connect failed");

        // Set up a workspace, then the `web` corpus exactly as the handler does.
        let workspace_id: Uuid = sqlx::query_scalar(
            "INSERT INTO public.workspaces (slug, display_name) VALUES ($1, $2) RETURNING id",
        )
        .bind(format!("web-ingest-{}", Uuid::new_v4()))
        .bind("Web Ingest Test")
        .fetch_one(&pool)
        .await
        .expect("workspace insert failed");

        let corpus_id = ensure_web_corpus(&pool, workspace_id)
            .await
            .expect("web corpus creation failed");

        let embedder = shared_embedder().await.expect("embedder load failed");

        let filename = "release-notes.md".to_string();
        let opts = IngestOptions {
            workspace_id,
            corpus_id,
            title: "Release Notes".into(),
            content: "The peregrine falcon is the fastest animal alive.".into(),
            format: Format::Markdown,
            external_id: Some(filename.clone()),
        };
        ingest_document(&pool, &embedder, opts)
            .await
            .expect("ingest should succeed");

        // GET /studio/docs list query: the filename appears.
        let listed: Vec<(Option<String>, String)> = sqlx::query_as(
            "SELECT external_id, title FROM nexum.documents WHERE workspace_id = $1 ORDER BY title",
        )
        .bind(workspace_id)
        .fetch_all(&pool)
        .await
        .expect("list query failed");
        assert!(
            listed
                .iter()
                .any(|(eid, _)| eid.as_deref() == Some(filename.as_str())),
            "ingested document must appear in the docs list"
        );

        // GET /studio/docs/{file} reconstruction: content stitches back.
        let (_doc_id, version_id): (Uuid, Option<Uuid>) = sqlx::query_as(
            "SELECT id, current_version_id FROM nexum.documents \
             WHERE workspace_id = $1 AND external_id = $2 LIMIT 1",
        )
        .bind(workspace_id)
        .bind(&filename)
        .fetch_one(&pool)
        .await
        .expect("doc lookup failed");
        let version_id = version_id.expect("document must have a current version");
        let blocks: Vec<(String,)> = sqlx::query_as(
            "SELECT b.content FROM nexum.version_blocks vb \
             JOIN nexum.blocks b ON b.id = vb.block_id \
             WHERE vb.version_id = $1 ORDER BY vb.seq",
        )
        .bind(version_id)
        .fetch_all(&pool)
        .await
        .expect("block fetch failed");
        let content = blocks
            .into_iter()
            .map(|(c,)| c)
            .collect::<Vec<_>>()
            .join("\n\n");
        assert!(
            content.contains("peregrine falcon"),
            "reconstructed content must contain the ingested text"
        );

        // Searchable through the existing brain full-text search.
        let results = fulltext_search(
            &pool,
            FullTextOptions {
                workspace_id,
                corpus_id,
                query_text: "peregrine".into(),
                limit: 10,
            },
        )
        .await
        .expect("fulltext search failed");
        assert!(
            results.iter().any(|r| r.content.contains("peregrine")),
            "ingested content must be searchable through brain search"
        );
    }
}
