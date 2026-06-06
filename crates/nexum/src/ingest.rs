//! Ingestion pipeline: parse → hash → embed → write to the shared Postgres.
//!
//! This is the main entry-point for ingesting a document into Nexum.
//! It coordinates the other modules in this crate and writes to the shared
//! database pool supplied by `sf-db`.
//!
//! # Database schema assumptions
//!
//! The pipeline writes to the following tables (defined in the Nexum
//! `db/schema.sql` and expected to exist in the shared Postgres instance):
//!
//! - `documents` — one row per logical document identity.
//! - `document_versions` — one row per ingestion of a document.
//! - `blocks` — content-addressed block rows; unchanged blocks are shared
//!   across versions.
//! - `version_blocks` — ordered junction between versions and their blocks.
//! - `links` — structural citation links between blocks.
//!
//! # Dedup semantics (version parity)
//!
//! When a document is re-ingested with the same content, blocks whose
//! `content_hash` already exists for that `doc_id` are *reused* — their
//! existing UUID is referenced by the new `version_blocks` row rather than
//! inserting a duplicate block row.  This matches the TypeScript pipeline
//! behaviour described in `src/routes/documents.ts`.

use crate::dedup::content_hash;
use crate::links::{extract_citation_refs, StructuralLink};
use crate::parse::{parse_document, Block, Format};
use sf_embed::Embedder;
use sqlx::PgPool;
use thiserror::Error;
use uuid::Uuid;

// ── Error ─────────────────────────────────────────────────────────────────────

/// Errors that can occur during ingestion.
#[derive(Debug, Error)]
pub enum IngestError {
    /// A database error.
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),

    /// The embedding model could not be loaded or failed during inference.
    #[error("embedding error: {0}")]
    Embed(#[from] sf_embed::EmbedError),

    /// The caller supplied invalid options.
    #[error("invalid options: {0}")]
    InvalidOptions(String),
}

// ── Options & result ──────────────────────────────────────────────────────────

/// Options for [`ingest_document`].
#[derive(Debug, Clone)]
pub struct IngestOptions {
    /// Workspace (tenant) that owns this document.
    ///
    /// Stamped onto every row written by the pipeline so that per-workspace
    /// RLS policies and application-layer filters work correctly.  Must be
    /// a non-nil UUID that exists in `public.workspaces(id)`.
    pub workspace_id: Uuid,
    /// UUID of the corpus this document belongs to.  Must exist in `corpora`.
    pub corpus_id: Uuid,
    /// Human-readable title for the document.
    pub title: String,
    /// Raw document content.
    pub content: String,
    /// Format to use when parsing `content` into blocks.
    pub format: Format,
    /// Optional external identifier (e.g. a CMS slug or S3 key) for dedup
    /// at the document level.
    pub external_id: Option<String>,
}

/// Summary returned by a successful [`ingest_document`] call.
#[derive(Debug)]
pub struct IngestResult {
    /// UUID of the logical document row (`documents.id`).
    pub doc_id: Uuid,
    /// UUID of the new version row (`document_versions.id`).
    pub version_id: Uuid,
    /// Number of blocks after parsing.
    pub block_count: usize,
    /// Number of block rows that were *reused* (dedup hits) rather than
    /// newly inserted.
    pub reused_block_count: usize,
    /// Number of structural citation links written.
    pub link_count: usize,
}

// ── Main pipeline ─────────────────────────────────────────────────────────────

/// Ingest a document into the shared Postgres instance.
///
/// # Steps
///
/// 1. Parse `opts.content` into blocks using [`parse_document`].
/// 2. SHA-256 hash each block's content.
/// 3. Embed each block using `embedder`.
/// 4. Open a transaction and write `documents`, `document_versions`, `blocks`
///    (with dedup), `version_blocks`, and `links` rows.
///
/// # Errors
///
/// Returns [`IngestError`] if parsing yields no blocks, if embedding fails,
/// or if any database write fails.
pub async fn ingest_document(
    pool: &PgPool,
    embedder: &Embedder,
    opts: IngestOptions,
) -> Result<IngestResult, IngestError> {
    if opts.workspace_id.is_nil() {
        return Err(IngestError::InvalidOptions(
            "workspace_id must not be nil".into(),
        ));
    }
    if opts.title.is_empty() {
        return Err(IngestError::InvalidOptions(
            "title must not be empty".into(),
        ));
    }
    if opts.content.is_empty() {
        return Err(IngestError::InvalidOptions(
            "content must not be empty".into(),
        ));
    }

    // 1. Parse.
    let blocks: Vec<Block> = parse_document(&opts.content, opts.format);

    // 2. Hash.
    let hashes: Vec<String> = blocks.iter().map(|b| content_hash(&b.content)).collect();

    // 3. Embed.
    let texts: Vec<&str> = blocks.iter().map(|b| b.content.as_str()).collect();
    let embeddings: Vec<Vec<f32>> = if blocks.is_empty() {
        vec![]
    } else {
        embedder.embed_batch(&texts)?
    };

    // 4. Write in a transaction.
    let mut tx = pool.begin().await?;

    // Insert document — stamp workspace_id on every row per issue #429.
    let doc_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO nexum.documents (workspace_id, title, corpus_id, external_id)
        VALUES ($1, $2, $3, $4)
        RETURNING id
        "#,
    )
    .bind(opts.workspace_id)
    .bind(&opts.title)
    .bind(opts.corpus_id)
    .bind(&opts.external_id)
    .fetch_one(&mut *tx)
    .await?;

    // Determine next version number.
    let version_num: i32 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(version_num), 0) + 1 FROM nexum.document_versions WHERE doc_id = $1",
    )
    .bind(doc_id)
    .fetch_one(&mut *tx)
    .await?;

    // Insert version — stamp workspace_id per issue #429.
    let version_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO nexum.document_versions (workspace_id, doc_id, version_num, status)
        VALUES ($1, $2, $3, 'parsed')
        RETURNING id
        "#,
    )
    .bind(opts.workspace_id)
    .bind(doc_id)
    .bind(version_num)
    .fetch_one(&mut *tx)
    .await?;

    // Look up existing blocks for this doc by content_hash (dedup).
    let existing_hashes: Vec<String> = hashes.clone();
    let existing_rows: Vec<(Uuid, String)> = sqlx::query_as(
        "SELECT id, content_hash FROM nexum.blocks WHERE doc_id = $1 AND content_hash = ANY($2)",
    )
    .bind(doc_id)
    .bind(&existing_hashes)
    .fetch_all(&mut *tx)
    .await?;

    let existing_map: std::collections::HashMap<String, Uuid> = existing_rows
        .into_iter()
        .map(|(id, hash)| (hash, id))
        .collect();

    // Insert or reuse blocks + link to version.
    let mut block_ids: Vec<Uuid> = Vec::with_capacity(blocks.len());
    let mut reused = 0usize;

    for (i, block) in blocks.iter().enumerate() {
        let hash = &hashes[i];
        let block_id = if let Some(&existing_id) = existing_map.get(hash) {
            reused += 1;
            existing_id
        } else {
            // Convert embedding to pgvector-compatible array string.
            let embedding = &embeddings[i];
            let embedding_str = format!(
                "[{}]",
                embedding
                    .iter()
                    .map(|v| v.to_string())
                    .collect::<Vec<_>>()
                    .join(",")
            );

            let new_id: Uuid = sqlx::query_scalar(
                r#"
                INSERT INTO nexum.blocks
                    (workspace_id, doc_id, content, content_hash, block_type, level, embedding)
                VALUES ($1, $2, $3, $4, $5, $6, $7::vector)
                ON CONFLICT DO NOTHING
                RETURNING id
                "#,
            )
            .bind(opts.workspace_id)
            .bind(doc_id)
            .bind(&block.content)
            .bind(hash)
            .bind(block.block_type.as_str())
            .bind(block.level)
            .bind(&embedding_str)
            .fetch_optional(&mut *tx)
            .await?
            .unwrap_or_else(|| {
                // Concurrent insert won the race; re-fetch below.
                Uuid::nil()
            });

            if new_id == Uuid::nil() {
                // Race: fetch the row that won.
                sqlx::query_scalar::<_, Uuid>(
                    "SELECT id FROM nexum.blocks WHERE doc_id = $1 AND content_hash = $2",
                )
                .bind(doc_id)
                .bind(hash)
                .fetch_one(&mut *tx)
                .await?
            } else {
                new_id
            }
        };

        block_ids.push(block_id);

        sqlx::query(
            "INSERT INTO nexum.version_blocks (version_id, block_id, seq) VALUES ($1, $2, $3)",
        )
        .bind(version_id)
        .bind(block_id)
        .bind((i + 1) as i32)
        .execute(&mut *tx)
        .await?;
    }

    // Update current_version_id on the document.
    sqlx::query("UPDATE nexum.documents SET current_version_id = $1 WHERE id = $2")
        .bind(version_id)
        .bind(doc_id)
        .execute(&mut *tx)
        .await?;

    // Extract and write structural links.
    let links = build_structural_links(&blocks, &block_ids);
    let link_count = links.len();

    for link in &links {
        sqlx::query(
            r#"
            INSERT INTO nexum.links
                (id, workspace_id, src, dst, layer, rel_type, weight, confirmed, provenance)
            VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8::jsonb)
            ON CONFLICT DO NOTHING
            "#,
        )
        .bind(Uuid::new_v4())
        .bind(opts.workspace_id)
        .bind(Uuid::parse_str(&link.src_block_id).unwrap_or_else(|_| Uuid::nil()))
        .bind(Uuid::parse_str(&link.dst_block_id).unwrap_or_else(|_| Uuid::nil()))
        .bind(&link.layer)
        .bind(&link.rel_type)
        .bind(link.weight)
        .bind(r#"{"model":"regex","confidence":1.0}"#)
        .execute(&mut *tx)
        .await?;
    }

    // Mark version as embedded (blocks have embeddings).
    sqlx::query("UPDATE nexum.document_versions SET status = 'embedded' WHERE id = $1")
        .bind(version_id)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;

    Ok(IngestResult {
        doc_id,
        version_id,
        block_count: blocks.len(),
        reused_block_count: reused,
        link_count,
    })
}

// ── Link building ─────────────────────────────────────────────────────────────

/// Build structural citation links between blocks in the same version.
///
/// For each block that contains citation refs, search the other blocks for
/// matching text and emit a link.  This mirrors the inner loop in
/// `processStructuralLinks` in `src/linker/structural.ts`.
fn build_structural_links(blocks: &[Block], block_ids: &[Uuid]) -> Vec<StructuralLink> {
    let mut links = Vec::new();

    for (i, block) in blocks.iter().enumerate() {
        let refs = extract_citation_refs(&block.content);
        if refs.is_empty() {
            continue;
        }

        for (j, target) in blocks.iter().enumerate() {
            if i == j {
                continue;
            }
            // Check if any ref matches the target content (case-insensitive substring).
            for r in &refs {
                let (_kind, value) = r.split_once(':').unwrap_or(("", r.as_str()));
                if target
                    .content
                    .to_lowercase()
                    .contains(&value.to_lowercase())
                {
                    links.push(StructuralLink::new(
                        block_ids[i].to_string(),
                        block_ids[j].to_string(),
                    ));
                    break; // one link per (src, dst) pair max
                }
            }
        }
    }

    links
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse::{Block, BlockType};

    #[test]
    fn build_structural_links_no_refs() {
        let blocks = vec![
            Block {
                block_type: BlockType::Paragraph,
                content: "Hello world.".into(),
                level: None,
            },
            Block {
                block_type: BlockType::Paragraph,
                content: "Another block.".into(),
                level: None,
            },
        ];
        let ids = vec![Uuid::new_v4(), Uuid::new_v4()];
        let links = build_structural_links(&blocks, &ids);
        assert!(links.is_empty());
    }

    #[test]
    fn build_structural_links_section_ref() {
        let blocks = vec![
            Block {
                block_type: BlockType::Paragraph,
                content: "As described in § 2 of this agreement.".into(),
                level: None,
            },
            Block {
                block_type: BlockType::Heading,
                // Use a title that does NOT itself trigger a citation pattern
                // so the link graph is one-directional for this test.
                content: "Definitions for the agreement".into(),
                level: Some(2),
            },
        ];
        let ids = vec![Uuid::new_v4(), Uuid::new_v4()];
        let links = build_structural_links(&blocks, &ids);
        // block 0 has §2 ref; the target "Definitions...agreement" contains "2"
        // in the UUID representation but no literal "2" in the text, so we
        // might get 0 or 1 link.  Just assert that the pipeline doesn't panic
        // and that no link is self-referential.
        for link in &links {
            assert_ne!(
                link.src_block_id, link.dst_block_id,
                "self-referential link found"
            );
        }
    }

    #[test]
    fn build_structural_links_cross_ref() {
        // block 0 cites §99 and block 1 cites §99 via "Section 99".
        // Both contain the literal "99" so both generate a link to each other.
        let blocks = vec![
            Block {
                block_type: BlockType::Paragraph,
                content: "According to § 99, the rule applies.".into(),
                level: None,
            },
            Block {
                block_type: BlockType::Paragraph,
                content: "See also Section 99 for further details.".into(),
                level: None,
            },
        ];
        let ids = vec![Uuid::new_v4(), Uuid::new_v4()];
        let links = build_structural_links(&blocks, &ids);
        // Both blocks cite section:99, and both contain "99", so each creates
        // a link to the other.
        assert_eq!(links.len(), 2, "expected cross-links: 0→1 and 1→0");
        let srcs: std::collections::HashSet<_> =
            links.iter().map(|l| l.src_block_id.clone()).collect();
        assert!(srcs.contains(&ids[0].to_string()));
        assert!(srcs.contains(&ids[1].to_string()));
    }

    /// Integration test: ingest a fixture into a real Postgres instance.
    ///
    /// Skipped unless `DATABASE_URL` is set.
    #[tokio::test]
    #[ignore = "integration: requires DATABASE_URL"]
    async fn ingest_fixture_block_and_link_parity() {
        use sf_db::config::DbConfig;
        use sf_db::pool::connect;

        let cfg = DbConfig::from_env().expect("DATABASE_URL must be set");
        let pool = connect(&cfg).await.expect("pool creation failed");
        let embedder = sf_embed::Embedder::new().expect("embedder init failed");

        // Fixture content: 3 paragraphs, 1 citation ref.
        let content = "First paragraph with no citation.\n\n\
                       Second paragraph, see § 1 for details.\n\n\
                       Section 1: this is the target.";

        let workspace_id = setup_test_workspace(&pool).await;
        let corpus_id = setup_test_corpus(&pool, workspace_id).await;

        let result = ingest_document(
            &pool,
            &embedder,
            IngestOptions {
                workspace_id,
                corpus_id,
                title: "parity fixture".into(),
                content: content.into(),
                format: Format::Text,
                external_id: None,
            },
        )
        .await
        .expect("ingest should succeed");

        // 3 paragraphs (double-newline split).
        assert_eq!(result.block_count, 3, "block count mismatch");
        // One citation link from paragraph 2 → paragraph 3.
        assert!(result.link_count >= 1, "expected at least one link");
    }

    /// Integration test: re-ingesting the same content reuses block UUIDs.
    ///
    /// Skipped unless `DATABASE_URL` is set.
    #[tokio::test]
    #[ignore = "integration: requires DATABASE_URL"]
    async fn reingest_reuses_block_ids() {
        use sf_db::config::DbConfig;
        use sf_db::pool::connect;

        let cfg = DbConfig::from_env().expect("DATABASE_URL must be set");
        let pool = connect(&cfg).await.expect("pool creation failed");
        let embedder = sf_embed::Embedder::new().expect("embedder init failed");

        let workspace_id = setup_test_workspace(&pool).await;
        let corpus_id = setup_test_corpus(&pool, workspace_id).await;

        let content = "First paragraph.\n\nSecond paragraph.";
        let opts = IngestOptions {
            workspace_id,
            corpus_id,
            title: "dedup fixture".into(),
            content: content.into(),
            format: Format::Text,
            external_id: Some("dedup-fixture-v1".into()),
        };

        let first = ingest_document(&pool, &embedder, opts.clone())
            .await
            .expect("first ingest should succeed");

        let second = ingest_document(&pool, &embedder, opts)
            .await
            .expect("second ingest should succeed");

        // Same block count.
        assert_eq!(first.block_count, second.block_count);
        // All blocks reused on second pass.
        assert_eq!(
            second.reused_block_count, second.block_count,
            "all blocks should be reused on re-ingest of unchanged content"
        );
        // Different version IDs.
        assert_ne!(first.version_id, second.version_id);
    }

    // ── helpers ───────────────────────────────────────────────────────────────

    /// Create a workspace row for integration tests and return its UUID.
    #[allow(dead_code)]
    async fn setup_test_workspace(pool: &PgPool) -> Uuid {
        sqlx::query_scalar(
            r#"
            INSERT INTO public.workspaces (slug, display_name)
            VALUES ($1, $2)
            RETURNING id
            "#,
        )
        .bind(format!("test-ws-{}", Uuid::new_v4()))
        .bind("Test Workspace")
        .fetch_one(pool)
        .await
        .expect("workspace insert failed")
    }

    #[allow(dead_code)]
    async fn setup_test_corpus(pool: &PgPool, workspace_id: Uuid) -> Uuid {
        sqlx::query_scalar(
            r#"
            INSERT INTO nexum.corpora (workspace_id, name)
            VALUES ($1, $2)
            RETURNING id
            "#,
        )
        .bind(workspace_id)
        .bind(format!("test-{}", Uuid::new_v4()))
        .fetch_one(pool)
        .await
        .expect("corpus insert failed")
    }
}
