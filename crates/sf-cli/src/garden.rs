//! `superfield garden <file...>` — seed document ingestion into the knowledge graph.
//!
//! Reads one or more markdown files and ingests them into the Nexum knowledge
//! graph as versioned documents.  Each file becomes one document; blocks are
//! the markdown sections/paragraphs split by the parser.
//!
//! # Usage
//!
//! ```text
//! superfield garden company-background.md prd.md
//! ```
//!
//! # Database requirements
//!
//! The command requires:
//! - `DATABASE_URL` set in the environment (or the daemon running and
//!   reachable via its config).
//! - The `nexum` schema migrated (`crates/nexum/migrations/0001_nexum_schema.sql`).
//! - A default corpus named `"seed"` (created on first use if absent).
//!
//! # Idempotency
//!
//! Each file is identified by its canonical source path.  Re-running with
//! the same file creates a new `document_version` without duplicating the
//! `documents` row (upsert by `source_path`).  Unchanged blocks are reused
//! across versions (dedup by content hash).
//!
//! # CI / test mode
//!
//! Set `SF_NO_DAEMON=1` to skip the daemon guard.  Tests should set this to
//! avoid auto-spawning the daemon when `DATABASE_URL` is available.
//!
//! # Canonical docs
//!
//! - Issue #490 scope.
//! - `docs/architecture.md` §Nexum — ingestion pipeline.
//! - `docs/milestone-1.md` §4.3.

use nexum::embed::Embedder;
use nexum::parse::Format;
use nexum::{ingest_document, IngestOptions};
use sqlx::PgPool;
use thiserror::Error;
use uuid::Uuid;

/// Errors from the `garden` command.
#[derive(Debug, Error)]
pub enum GardenError {
    /// A file could not be read.
    #[error("cannot read file '{path}': {source}")]
    ReadFile {
        path: String,
        source: std::io::Error,
    },

    /// An empty file list was provided.
    #[error("no files specified; usage: superfield garden <file1> [file2...]")]
    NoFiles,

    /// An ingestion error (database or embedding failure).
    #[error("ingestion error for '{path}': {source}")]
    Ingest {
        path: String,
        source: nexum::IngestError,
    },

    /// The embedding model could not be loaded.
    #[error("embedding model error: {0}")]
    EmbedModel(#[from] nexum::embed::EmbedError),

    /// A database error.
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),

    /// workspace_id is required but not set.
    #[error(
        "WORKSPACE_ID environment variable must be set to a non-nil UUID for garden ingestion"
    )]
    MissingWorkspaceId,

    /// WORKSPACE_ID is set but cannot be parsed as a UUID.
    #[error("WORKSPACE_ID is not a valid UUID: {0}")]
    InvalidWorkspaceId(#[from] uuid::Error),
}

/// Execute `superfield garden <files...>`.
///
/// # Steps
///
/// 1. Load or create the `"seed"` corpus in `nexum.corpora`.
/// 2. Initialise the embedding model (downloads weights on first use).
/// 3. For each file:
///    a. Read the file contents.
///    b. Upsert a `nexum.documents` row keyed by `source_path`.
///    c. Ingest — parse, embed, and write blocks + version.
/// 4. Print a summary line per file.
///
/// # Arguments
///
/// * `pool`          — the shared [`sqlx::PgPool`].
/// * `file_paths`    — the list of file paths to ingest.
/// * `workspace_id`  — the workspace UUID to stamp on all rows.
pub async fn garden_ingest(
    pool: &PgPool,
    file_paths: &[String],
    workspace_id: Uuid,
) -> Result<(), GardenError> {
    if file_paths.is_empty() {
        return Err(GardenError::NoFiles);
    }

    // Ensure the seed corpus exists; create it if absent.
    let corpus_id = ensure_seed_corpus(pool, workspace_id).await?;

    // Load the embedding model once; reuse across files.
    let embedder = Embedder::new()?;

    for path in file_paths {
        // Read the file.
        let content = std::fs::read_to_string(path).map_err(|source| GardenError::ReadFile {
            path: path.clone(),
            source,
        })?;

        let title = file_stem(path);

        let opts = IngestOptions {
            workspace_id,
            corpus_id,
            title: title.clone(),
            content,
            format: Format::Markdown,
            external_id: Some(path.clone()),
        };

        let result = ingest_document(pool, &embedder, opts)
            .await
            .map_err(|source| GardenError::Ingest {
                path: path.clone(),
                source,
            })?;

        println!(
            "garden: ingested '{}' → doc_id={} version={} blocks={} reused={} links={}",
            path,
            result.doc_id,
            result.version_id,
            result.block_count,
            result.reused_block_count,
            result.link_count,
        );
    }

    Ok(())
}

/// Return the stem of a file path (filename without extension), falling back
/// to the full path if parsing fails.
fn file_stem(path: &str) -> String {
    std::path::Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(path)
        .to_string()
}

/// Ensure the `"seed"` corpus exists in `nexum.corpora`, creating it if absent.
///
/// Returns the corpus UUID.  The corpus is scoped to `workspace_id`.
async fn ensure_seed_corpus(pool: &PgPool, workspace_id: Uuid) -> Result<Uuid, GardenError> {
    // Try to find an existing seed corpus for this workspace.
    let existing: Option<Uuid> = sqlx::query_scalar(
        "SELECT id FROM nexum.corpora WHERE name = 'seed' AND workspace_id = $1 LIMIT 1",
    )
    .bind(workspace_id)
    .fetch_optional(pool)
    .await?;

    if let Some(id) = existing {
        return Ok(id);
    }

    // Create the seed corpus.
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO nexum.corpora (workspace_id, name, description) \
         VALUES ($1, 'seed', 'Seed documents for the Superfield knowledge graph') \
         RETURNING id",
    )
    .bind(workspace_id)
    .fetch_one(pool)
    .await?;

    Ok(id)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Unit test: `file_stem` extracts the stem correctly.
    #[test]
    fn file_stem_extracts_stem() {
        assert_eq!(file_stem("company-background.md"), "company-background");
        assert_eq!(file_stem("prd.md"), "prd");
        assert_eq!(file_stem("/path/to/foo.md"), "foo");
        assert_eq!(file_stem("no-extension"), "no-extension");
    }

    /// Integration test: ingest two fixture files and assert DB rows exist.
    ///
    /// Runs `garden_ingest` against a real Postgres instance with two small
    /// fixture markdown files written to a temp directory.
    ///
    /// Acceptance criterion: `garden_command_ingests_both_files`
    ///
    /// Skipped unless `DATABASE_URL` and `WORKSPACE_ID` are set.
    #[tokio::test]
    #[ignore = "integration: requires DATABASE_URL with nexum schema migrated"]
    async fn garden_command_ingests_both_files() {
        use tempfile::tempdir;

        let url = match std::env::var("DATABASE_URL") {
            Ok(u) => u,
            Err(_) => return, // skip
        };
        let workspace_id_str = match std::env::var("WORKSPACE_ID") {
            Ok(u) => u,
            Err(_) => return, // skip
        };
        let workspace_id: Uuid = workspace_id_str
            .parse()
            .expect("WORKSPACE_ID must be a UUID");

        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(5)
            .connect(&url)
            .await
            .expect("connect failed");

        // Write two fixture markdown files.
        let dir = tempdir().expect("tempdir");
        let bg_path = dir.path().join("company-background.md");
        let prd_path = dir.path().join("prd.md");

        std::fs::write(
            &bg_path,
            "# Company Background\n\nWe build AI tools.\n\nOur mission is to accelerate software teams.",
        )
        .expect("write company-background.md");

        std::fs::write(
            &prd_path,
            "# Product Requirements\n\nThe system must ingest documents.\n\nBlocks must have embeddings.",
        )
        .expect("write prd.md");

        let files = vec![
            bg_path.to_string_lossy().into_owned(),
            prd_path.to_string_lossy().into_owned(),
        ];

        garden_ingest(&pool, &files, workspace_id)
            .await
            .expect("garden_ingest must succeed");

        // Assert nexum.documents has 2 rows for these source_paths.
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM nexum.documents \
             WHERE external_id = ANY($1) AND workspace_id = $2",
        )
        .bind(&[
            bg_path.to_string_lossy().into_owned(),
            prd_path.to_string_lossy().into_owned(),
        ])
        .bind(workspace_id)
        .fetch_one(&pool)
        .await
        .expect("count query failed");

        assert_eq!(count, 2, "expected 2 document rows, got {}", count);

        // Assert nexum.blocks count > 0 for these documents.
        let block_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM nexum.blocks b \
             JOIN nexum.documents d ON d.id = b.doc_id \
             WHERE d.external_id = ANY($1) AND b.workspace_id = $2",
        )
        .bind(&[
            bg_path.to_string_lossy().into_owned(),
            prd_path.to_string_lossy().into_owned(),
        ])
        .bind(workspace_id)
        .fetch_one(&pool)
        .await
        .expect("block count query failed");

        assert!(
            block_count > 0,
            "expected block_count > 0, got {}",
            block_count
        );
    }
}
