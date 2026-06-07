//! Integration tests for the `nexum` crate against a live Postgres instance.
//!
//! All tests are skipped unless `DATABASE_URL` is set in the environment.
//! Each test isolates its data via unique UUIDs and cleans up after itself
//! (DELETE by those UUIDs) so that tests can be run against a shared schema
//! without leaving residue.
//!
//! # Running
//!
//! ```bash
//! DATABASE_URL=postgres://… cargo test -p nexum --test integration
//! ```
//!
//! # Test plan (issues #366, #367)
//!
//! 1. Ingest round-trip — insert a doc, verify blocks and embeddings appear in
//!    `nexum.blocks`.
//! 2. Full-text search — ingest distinctive text, assert `fulltext_search`
//!    returns it.
//! 3. Semantic search — ingest a doc, embed a similar query, assert
//!    `semantic_search` returns a result with `score > 0`.
//! 4. Graph search — seed the `nexum.links` table with a known link, call
//!    `graph_search` from the seed block, assert the linked block appears.
//! 5. Causal chain — seed `entities` + `relations` for the full
//!    error→session→user→requirement→code chain, call
//!    `error_to_cause_chain`, assert no missing hops.

use nexum::dedup::content_hash;
use nexum::links::embed_edge;
use nexum::parse::Format;
use nexum::{
    classify_pair, edge_semantic_search, error_to_cause_chain, fulltext_search, graph_search,
    hybrid_search, ingest_document, semantic_search, EdgeProbe, EdgeSemanticOptions, FullTextOptions,
    GraphOptions, HybridOptions, IngestOptions, SemanticOptions,
};
use nexum::embed::Embedder;
use sqlx::PgPool;
use uuid::Uuid;

// ── Out-of-scope TS tests ───────────────────────────────────────────────────────
//
// The TypeScript suite under `nexum/tests/` exercises several features that this
// pure-library crate deliberately does NOT implement (see
// `docs/rust-reorg-decisions.md` §7).  The following TS scenarios are EXPLICITLY
// out of scope here and are intentionally not ported:
//
// - AGE graph mirroring + Cypher graphSearch (`age-edges.test.ts`,
//   `graph-cypher.test.ts`, `hybrid-cypher.test.ts`, `backfill-links-to-age.*`):
//   graph traversal in this crate uses a recursive CTE, not Apache AGE.
// - HTTP route handlers / in-process server (`server.test.mjs`, `auth.test.mjs`,
//   the `runGraphQuery`/`ensureServer` paths): HTTP mode-dispatch belongs to
//   sf-serve, not this library.
// - Synthesis / synthesized-block endpoints (`synthesize-endpoint.test.ts`,
//   `synthesized-block-schema.test.ts`, `phase4-synthesis-seams.test.mjs`,
//   `stale-propagation.test.ts`): no synthesis feature exists in this crate.
// - InferenceClient abstraction + hosted/local adapters
//   (`inference-client.test.mjs`, `hosted-adapters.test.mjs`,
//   `local-cpu-inference-client.test.mjs`, `linker-inference-adapters.test.mjs`):
//   out of scope; the linker uses a fixed keyword heuristic (`classify_pair`).
// - PDF/DOCX parsers (`pdf-ingest.test.mjs`, `docx-ingest.test.mjs`): moved to a
//   template/framework (reorg #37), not this crate.

// ── Pool helper ───────────────────────────────────────────────────────────────

/// Connect to the database at `DATABASE_URL`, or return `None` to skip.
async fn maybe_pool() -> Option<PgPool> {
    let url = std::env::var("DATABASE_URL").ok()?;
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(5)
        .connect(&url)
        .await
        .expect("failed to connect to DATABASE_URL");
    Some(pool)
}

// ── Seed helpers ──────────────────────────────────────────────────────────────

/// Insert a test corpus and return its UUID.
async fn insert_corpus(pool: &PgPool) -> Uuid {
    sqlx::query_scalar("INSERT INTO nexum.corpora (name) VALUES ($1) RETURNING id")
        .bind(format!("nexum-test-corpus-{}", Uuid::new_v4()))
        .fetch_one(pool)
        .await
        .expect("corpus insert failed")
}

/// Insert a bare block (no embedding, no tsv) in `nexum.blocks`.
async fn insert_block_bare(pool: &PgPool, doc_id: Uuid, content: &str) -> Uuid {
    let hash = content_hash(content);
    sqlx::query_scalar(
        r#"INSERT INTO nexum.blocks (doc_id, content, content_hash, block_type)
           VALUES ($1, $2, $3, 'paragraph') RETURNING id"#,
    )
    .bind(doc_id)
    .bind(content)
    .bind(hash)
    .fetch_one(pool)
    .await
    .expect("bare block insert failed")
}

/// Insert a bare document and return its UUID.
async fn insert_document(pool: &PgPool, corpus_id: Uuid, title: &str) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO nexum.documents (corpus_id, title) VALUES ($1, $2) RETURNING id",
    )
    .bind(corpus_id)
    .bind(title)
    .fetch_one(pool)
    .await
    .expect("document insert failed")
}

/// Insert a block with a tsvector (for full-text tests).
async fn insert_block_tsv(pool: &PgPool, doc_id: Uuid, content: &str) -> Uuid {
    let hash = content_hash(content);
    sqlx::query_scalar(
        // `tsv` is a GENERATED ALWAYS column — never inserted explicitly.
        r#"INSERT INTO nexum.blocks (doc_id, content, content_hash, block_type)
           VALUES ($1, $2, $3, 'paragraph') RETURNING id"#,
    )
    .bind(doc_id)
    .bind(content)
    .bind(hash)
    .fetch_one(pool)
    .await
    .expect("tsv block insert failed")
}

/// Insert a block with a real embedding (for semantic/edge tests).
async fn insert_block_embedded(
    pool: &PgPool,
    doc_id: Uuid,
    content: &str,
    embedder: &Embedder,
) -> Uuid {
    let hash = content_hash(content);
    let vec = embedder.embed_one(content).expect("embed_one failed");
    let vec_str = format!(
        "[{}]",
        vec.iter().map(|v| v.to_string()).collect::<Vec<_>>().join(",")
    );
    sqlx::query_scalar(
        // `tsv` is a GENERATED ALWAYS column — never inserted explicitly.
        r#"INSERT INTO nexum.blocks (doc_id, content, content_hash, block_type, embedding)
           VALUES ($1, $2, $3, 'paragraph', $4::vector) RETURNING id"#,
    )
    .bind(doc_id)
    .bind(content)
    .bind(hash)
    .bind(&vec_str)
    .fetch_one(pool)
    .await
    .expect("embedded block insert failed")
}

/// Insert a link in `nexum.links`.
async fn insert_link(pool: &PgPool, src: Uuid, dst: Uuid, layer: &str) -> Uuid {
    let link_id = Uuid::new_v4();
    sqlx::query(
        // `provenance` is jsonb NOT NULL with no default — supply an empty object.
        r#"INSERT INTO nexum.links (id, src, dst, layer, rel_type, weight, provenance)
           VALUES ($1, $2, $3, $4, 'cites', 1.0, '{}'::jsonb)"#,
    )
    .bind(link_id)
    .bind(src)
    .bind(dst)
    .bind(layer)
    .execute(pool)
    .await
    .expect("link insert failed");
    link_id
}

/// Insert an entity into the `entities` table (public schema).
async fn insert_entity(pool: &PgPool, entity_type: &str, props: serde_json::Value) -> Uuid {
    sqlx::query_scalar("INSERT INTO nexum.entities (type, properties) VALUES ($1, $2) RETURNING id")
        .bind(entity_type)
        .bind(props)
        .fetch_one(pool)
        .await
        .expect("entity insert failed")
}

/// Insert a relation into the `relations` table (public schema).
async fn insert_relation(pool: &PgPool, source_id: Uuid, target_id: Uuid, rel_type: &str) {
    sqlx::query("INSERT INTO nexum.relations (source_id, target_id, type) VALUES ($1, $2, $3)")
        .bind(source_id)
        .bind(target_id)
        .bind(rel_type)
        .execute(pool)
        .await
        .expect("relation insert failed");
}

// ── Cleanup helpers ───────────────────────────────────────────────────────────

/// Delete a corpus and its cascade (documents, blocks, version_blocks, links
/// via FK cascade if configured; otherwise delete in order).
async fn cleanup_corpus(pool: &PgPool, corpus_id: Uuid) {
    // Remove version_blocks that reference blocks in this corpus.
    sqlx::query(
        r#"DELETE FROM nexum.version_blocks
           WHERE block_id IN (
               SELECT b.id FROM nexum.blocks b
               JOIN nexum.documents d ON d.id = b.doc_id
               WHERE d.corpus_id = $1
           )"#,
    )
    .bind(corpus_id)
    .execute(pool)
    .await
    .ok();

    // Remove links whose src or dst blocks belong to this corpus.
    sqlx::query(
        r#"DELETE FROM nexum.links
           WHERE src IN (
               SELECT b.id FROM nexum.blocks b
               JOIN nexum.documents d ON d.id = b.doc_id
               WHERE d.corpus_id = $1
           ) OR dst IN (
               SELECT b.id FROM nexum.blocks b
               JOIN nexum.documents d ON d.id = b.doc_id
               WHERE d.corpus_id = $1
           )"#,
    )
    .bind(corpus_id)
    .execute(pool)
    .await
    .ok();

    sqlx::query("DELETE FROM nexum.blocks WHERE doc_id IN (SELECT id FROM nexum.documents WHERE corpus_id = $1)")
        .bind(corpus_id)
        .execute(pool)
        .await
        .ok();

    sqlx::query("DELETE FROM nexum.document_versions WHERE doc_id IN (SELECT id FROM nexum.documents WHERE corpus_id = $1)")
        .bind(corpus_id)
        .execute(pool)
        .await
        .ok();

    sqlx::query("DELETE FROM nexum.documents WHERE corpus_id = $1")
        .bind(corpus_id)
        .execute(pool)
        .await
        .ok();

    sqlx::query("DELETE FROM nexum.corpora WHERE id = $1")
        .bind(corpus_id)
        .execute(pool)
        .await
        .ok();
}

/// Delete entities and relations by a list of entity UUIDs.
async fn cleanup_entities(pool: &PgPool, ids: &[Uuid]) {
    for id in ids {
        sqlx::query("DELETE FROM nexum.relations WHERE source_id = $1 OR target_id = $1")
            .bind(id)
            .execute(pool)
            .await
            .ok();
    }
    for id in ids {
        sqlx::query("DELETE FROM nexum.entities WHERE id = $1")
            .bind(id)
            .execute(pool)
            .await
            .ok();
    }
}

// ── Test 1: Ingest round-trip ─────────────────────────────────────────────────

/// Ingest a document and verify that block rows (with embeddings) appear in
/// `nexum.blocks`.
///
/// Acceptance criterion (issue #366): the parse→embed→store pipeline
/// persists at least one block with a non-null embedding for the ingested doc.
#[tokio::test]
async fn test_ingest_round_trip() {
    let pool = match maybe_pool().await {
        Some(p) => p,
        None => return,
    };

    let embedder = Embedder::new().expect("embedder init failed");
    let corpus_id = insert_corpus(&pool).await;

    let content = "The quick brown fox.\n\nSecond paragraph here.";
    let result = ingest_document(
        &pool,
        &embedder,
        IngestOptions {
            corpus_id,
            title: format!("ingest-test-{}", Uuid::new_v4()),
            content: content.into(),
            format: Format::Text,
            external_id: None,
        },
    )
    .await
    .expect("ingest_document must succeed");

    // Verify blocks were written.
    assert!(result.block_count > 0, "expected at least one block");

    // Verify rows exist in nexum.blocks with non-null embeddings.
    let (count, embedding_count): (i64, i64) = sqlx::query_as(
        r#"SELECT COUNT(*), COUNT(embedding)
           FROM nexum.blocks
           WHERE doc_id = $1"#,
    )
    .bind(result.doc_id)
    .fetch_one(&pool)
    .await
    .expect("block count query failed");

    assert_eq!(
        count, result.block_count as i64,
        "nexum.blocks row count must match block_count"
    );
    assert_eq!(
        embedding_count, count,
        "every block must have a non-null embedding"
    );

    cleanup_corpus(&pool, corpus_id).await;
}

// ── Test 2: Full-text search ──────────────────────────────────────────────────

/// Ingest a document containing a distinctive phrase, then verify that
/// `fulltext_search` returns it.
///
/// Acceptance criterion (issue #367): full-text search returns the ingested
/// block for a query that matches its content.
#[tokio::test]
async fn test_fulltext_search_finds_ingested_doc() {
    let pool = match maybe_pool().await {
        Some(p) => p,
        None => return,
    };

    let embedder = Embedder::new().expect("embedder init failed");
    let corpus_id = insert_corpus(&pool).await;

    // Use a highly distinctive phrase unlikely to collide with other test data.
    let run_id = Uuid::new_v4().to_string().replace('-', "");
    let distinctive = format!("zxqvft{} is a unique test phrase", &run_id[..8]);
    let content = distinctive.clone();

    ingest_document(
        &pool,
        &embedder,
        IngestOptions {
            corpus_id,
            title: format!("ft-search-test-{}", Uuid::new_v4()),
            content: content.clone(),
            format: Format::Text,
            external_id: None,
        },
    )
    .await
    .expect("ingest_document must succeed");

    // The tsvector is computed from the content; search for a literal word
    // from the distinctive phrase.
    let search_word = format!("zxqvft{}", &run_id[..8]);
    let results = fulltext_search(
        &pool,
        FullTextOptions {
            corpus_id,
            query_text: search_word.clone(),
            limit: 10,
        },
    )
    .await
    .expect("fulltext_search must succeed");

    assert!(
        !results.is_empty(),
        "fulltext_search must return at least one result for '{}'",
        search_word
    );
    assert!(
        results.iter().any(|r| r.content.contains(&search_word)),
        "at least one result must contain the distinctive word '{}'",
        search_word
    );

    cleanup_corpus(&pool, corpus_id).await;
}

// ── Test 3: Semantic search ───────────────────────────────────────────────────

/// Ingest a document, embed a semantically similar query, and verify that
/// `semantic_search` returns at least one result with `score > 0`.
///
/// Acceptance criterion (issue #367): semantic search returns the ingested
/// block with a positive cosine-similarity score.
#[tokio::test]
async fn test_semantic_search_returns_positive_score() {
    let pool = match maybe_pool().await {
        Some(p) => p,
        None => return,
    };

    let embedder = Embedder::new().expect("embedder init failed");
    let corpus_id = insert_corpus(&pool).await;

    ingest_document(
        &pool,
        &embedder,
        IngestOptions {
            corpus_id,
            title: format!("sem-search-test-{}", Uuid::new_v4()),
            content: "Rust is a systems programming language focused on safety and performance."
                .into(),
            format: Format::Text,
            external_id: None,
        },
    )
    .await
    .expect("ingest_document must succeed");

    let results = semantic_search(
        &pool,
        &embedder,
        SemanticOptions {
            corpus_id,
            query_text: "systems programming language".into(),
            limit: 10,
        },
    )
    .await
    .expect("semantic_search must succeed");

    assert!(
        !results.is_empty(),
        "semantic_search must return at least one result"
    );
    assert!(
        results[0].score > 0.0,
        "top semantic result must have score > 0, got {}",
        results[0].score
    );

    cleanup_corpus(&pool, corpus_id).await;
}

// ── Test 4: Graph search ──────────────────────────────────────────────────────

/// Seed two blocks with a known `nexum.links` edge between them, call
/// `graph_search` from the source block, and verify the destination block
/// appears in the results.
///
/// Acceptance criterion (issue #367): graph traversal via recursive CTE
/// returns one-hop neighbours correctly.
#[tokio::test]
async fn test_graph_search_returns_linked_block() {
    let pool = match maybe_pool().await {
        Some(p) => p,
        None => return,
    };

    let corpus_id = insert_corpus(&pool).await;

    // Insert a bare document so blocks have a valid doc_id.
    let doc_id: Uuid = sqlx::query_scalar(
        "INSERT INTO nexum.documents (corpus_id, title) VALUES ($1, $2) RETURNING id",
    )
    .bind(corpus_id)
    .bind(format!("graph-test-doc-{}", Uuid::new_v4()))
    .fetch_one(&pool)
    .await
    .expect("document insert failed");

    let src_id = insert_block_bare(&pool, doc_id, "Graph source block for test").await;
    let dst_id = insert_block_bare(&pool, doc_id, "Graph destination block for test").await;
    insert_link(&pool, src_id, dst_id, "structural").await;

    let results = graph_search(
        &pool,
        GraphOptions {
            seed_block_id: src_id,
            max_hops: 1,
            layers: vec!["structural".into()],
            limit: 10,
        },
    )
    .await
    .expect("graph_search must succeed");

    assert_eq!(
        results.len(),
        1,
        "expected exactly one graph neighbour, got {}",
        results.len()
    );
    assert_eq!(
        results[0].block_id, dst_id,
        "graph result must be the seeded destination block"
    );
    assert_eq!(results[0].depth, 1, "one-hop result must have depth = 1");

    cleanup_corpus(&pool, corpus_id).await;
}

// ── Test 5: Causal chain ──────────────────────────────────────────────────────

/// Seed the full error→session→user→requirement→code chain and verify that
/// `error_to_cause_chain` resolves all hops with no missing entries.
///
/// Acceptance criterion (issue #367): causal-chain traversal covers all five
/// entity types and reports `missing_hops` as empty when the full chain is
/// present.
#[tokio::test]
async fn test_causal_chain_full_five_node_chain() {
    let pool = match maybe_pool().await {
        Some(p) => p,
        None => return,
    };

    let run_tag = Uuid::new_v4().to_string();

    let error_id = insert_entity(
        &pool,
        "error",
        serde_json::json!({"message": format!("test-error-{}", run_tag)}),
    )
    .await;
    let session_id = insert_entity(
        &pool,
        "session",
        serde_json::json!({"run": run_tag.clone()}),
    )
    .await;
    let user_id = insert_entity(
        &pool,
        "user",
        serde_json::json!({"name": format!("test-user-{}", run_tag)}),
    )
    .await;
    let req_id = insert_entity(
        &pool,
        "requirement",
        serde_json::json!({"title": format!("test-req-{}", run_tag)}),
    )
    .await;
    let code_id = insert_entity(
        &pool,
        "code",
        serde_json::json!({"path": format!("src/{}.rs", run_tag)}),
    )
    .await;

    // Wire the chain: error→session→user, session→requirement→code.
    insert_relation(&pool, error_id, session_id, "caused_in").await;
    insert_relation(&pool, session_id, user_id, "initiated_by").await;
    insert_relation(&pool, session_id, req_id, "fulfills").await;
    insert_relation(&pool, req_id, code_id, "implemented_by").await;

    let chain = error_to_cause_chain(&pool, error_id)
        .await
        .expect("error_to_cause_chain must succeed");

    assert!(
        chain.missing_hops.is_empty(),
        "expected no missing hops, got: {:?}",
        chain.missing_hops
    );
    assert_eq!(
        chain.error.id, error_id,
        "error node must match the seeded error entity"
    );
    assert!(chain.session.is_some(), "session hop must be resolved");
    assert_eq!(
        chain.session.as_ref().unwrap().id,
        session_id,
        "session node must match the seeded session entity"
    );
    assert!(chain.user.is_some(), "user hop must be resolved");
    assert_eq!(
        chain.user.as_ref().unwrap().id,
        user_id,
        "user node must match the seeded user entity"
    );
    assert!(
        chain.requirement.is_some(),
        "requirement hop must be resolved"
    );
    assert_eq!(
        chain.requirement.as_ref().unwrap().id,
        req_id,
        "requirement node must match the seeded requirement entity"
    );
    assert!(chain.code.is_some(), "code hop must be resolved");
    assert_eq!(
        chain.code.as_ref().unwrap().id,
        code_id,
        "code node must match the seeded code entity"
    );

    cleanup_entities(&pool, &[error_id, session_id, user_id, req_id, code_id]).await;
}

/// Verify that a broken chain (error→session only) reports the missing hops
/// correctly.
#[tokio::test]
async fn test_causal_chain_partial_reports_missing_hops() {
    let pool = match maybe_pool().await {
        Some(p) => p,
        None => return,
    };

    let run_tag = Uuid::new_v4().to_string();

    let error_id = insert_entity(
        &pool,
        "error",
        serde_json::json!({"message": format!("partial-error-{}", run_tag)}),
    )
    .await;
    let session_id = insert_entity(
        &pool,
        "session",
        serde_json::json!({"run": run_tag.clone()}),
    )
    .await;

    // Only the error→session hop; no user/requirement/code links.
    insert_relation(&pool, error_id, session_id, "caused_in").await;

    let chain = error_to_cause_chain(&pool, error_id)
        .await
        .expect("error_to_cause_chain must succeed even with a broken chain");

    assert!(
        chain.session.is_some(),
        "session must be resolved when caused_in link exists"
    );
    assert!(
        chain.user.is_none(),
        "user must be None when initiated_by link is absent"
    );
    assert!(
        chain.requirement.is_none(),
        "requirement must be None when fulfills link is absent"
    );
    assert!(
        chain.code.is_none(),
        "code must be None when implemented_by link is absent"
    );
    assert!(
        chain.missing_hops.contains(&"user".to_string()),
        "missing_hops must contain 'user'"
    );
    assert!(
        chain.missing_hops.contains(&"requirement".to_string()),
        "missing_hops must contain 'requirement'"
    );
    assert!(
        chain.missing_hops.contains(&"code".to_string()),
        "missing_hops must contain 'code'"
    );

    cleanup_entities(&pool, &[error_id, session_id]).await;
}

// ── Test 6: seq ordering (port of ingest-query.test.ts) ─────────────────────────

/// Ingesting a multi-paragraph document records `version_blocks.seq` as a
/// contiguous 1..=N sequence in parse order.
///
/// Ports the TS `ingest text document creates blocks with correct seq` scenario.
#[tokio::test]
async fn test_version_blocks_seq_ordering() {
    let pool = match maybe_pool().await {
        Some(p) => p,
        None => return,
    };

    let embedder = Embedder::new().expect("embedder init failed");
    let corpus_id = insert_corpus(&pool).await;

    let content = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.";
    let result = ingest_document(
        &pool,
        &embedder,
        IngestOptions {
            corpus_id,
            title: format!("seq-test-{}", Uuid::new_v4()),
            content: content.into(),
            format: Format::Text,
            external_id: None,
        },
    )
    .await
    .expect("ingest_document must succeed");

    assert_eq!(result.block_count, 3, "expected three paragraph blocks");

    let seqs: Vec<i32> = sqlx::query_scalar(
        "SELECT seq FROM nexum.version_blocks WHERE version_id = $1 ORDER BY seq",
    )
    .bind(result.version_id)
    .fetch_all(&pool)
    .await
    .expect("seq query failed");

    assert_eq!(seqs, vec![1, 2, 3], "seq must be a contiguous 1..=N sequence");

    cleanup_corpus(&pool, corpus_id).await;
}

// ── Test 7: block dedup on re-ingest (port of ingest-query.test.ts) ─────────────

/// Re-ingesting identical content reuses the existing block rows: both versions'
/// `version_blocks` reference the same block UUIDs and no new block rows appear.
///
/// Ports the TS `block dedup: same content reuses block id` scenario.
#[tokio::test]
async fn test_block_dedup_reuses_block_ids() {
    let pool = match maybe_pool().await {
        Some(p) => p,
        None => return,
    };

    let embedder = Embedder::new().expect("embedder init failed");
    let corpus_id = insert_corpus(&pool).await;

    let opts = IngestOptions {
        corpus_id,
        title: format!("dedup-test-{}", Uuid::new_v4()),
        content: "Shared unchanged paragraph text.\n\nA second shared paragraph.".into(),
        format: Format::Text,
        external_id: None,
    };

    let first = ingest_document(&pool, &embedder, opts.clone())
        .await
        .expect("first ingest must succeed");
    let second = ingest_document(&pool, &embedder, opts)
        .await
        .expect("second ingest must succeed");

    assert_eq!(first.block_count, second.block_count);
    assert_eq!(
        second.reused_block_count, second.block_count,
        "all blocks must be reused on re-ingest of unchanged content"
    );
    assert_ne!(first.version_id, second.version_id);

    // Both versions must reference the exact same set of block ids.
    let v1: Vec<Uuid> = sqlx::query_scalar(
        "SELECT block_id FROM nexum.version_blocks WHERE version_id = $1 ORDER BY seq",
    )
    .bind(first.version_id)
    .fetch_all(&pool)
    .await
    .expect("v1 blocks query failed");
    let v2: Vec<Uuid> = sqlx::query_scalar(
        "SELECT block_id FROM nexum.version_blocks WHERE version_id = $1 ORDER BY seq",
    )
    .bind(second.version_id)
    .fetch_all(&pool)
    .await
    .expect("v2 blocks query failed");
    assert_eq!(v1, v2, "both versions must reference the same block ids");

    cleanup_corpus(&pool, corpus_id).await;
}

// ── Test 8: external_id round-trip (port of ingest-query.test.ts) ───────────────

/// An `external_id` supplied at ingest time is persisted on the document row and
/// surfaced back through query results' `DocRef.external_id`.
///
/// Ports the TS `external_id is stored and retrievable` scenario.
#[tokio::test]
async fn test_external_id_round_trip() {
    let pool = match maybe_pool().await {
        Some(p) => p,
        None => return,
    };

    let embedder = Embedder::new().expect("embedder init failed");
    let corpus_id = insert_corpus(&pool).await;

    let ext = format!("cuad-{}", Uuid::new_v4());
    let distinctive = format!("indemnification clause qzext{}", &ext[5..13]);
    let result = ingest_document(
        &pool,
        &embedder,
        IngestOptions {
            corpus_id,
            title: format!("eid-test-{}", Uuid::new_v4()),
            content: distinctive.clone(),
            format: Format::Text,
            external_id: Some(ext.clone()),
        },
    )
    .await
    .expect("ingest_document must succeed");

    // Direct column check.
    let stored: Option<String> =
        sqlx::query_scalar("SELECT external_id FROM nexum.documents WHERE id = $1")
            .bind(result.doc_id)
            .fetch_one(&pool)
            .await
            .expect("external_id query failed");
    assert_eq!(stored.as_deref(), Some(ext.as_str()));

    // Round-trip through a query result's DocRef.
    let results = fulltext_search(
        &pool,
        FullTextOptions {
            corpus_id,
            query_text: format!("qzext{}", &ext[5..13]),
            limit: 10,
        },
    )
    .await
    .expect("fulltext_search must succeed");
    assert!(!results.is_empty(), "expected a full-text hit");
    assert_eq!(
        results[0].document.external_id.as_deref(),
        Some(ext.as_str()),
        "DocRef.external_id must round-trip"
    );

    cleanup_corpus(&pool, corpus_id).await;
}

// ── Test 9: full-text corpus scoping (port of ingest-query.test.ts) ─────────────

/// Full-text search is scoped to its corpus: a distinctive term present only in
/// corpus A is invisible to a search issued against corpus B.
///
/// Ports the TS `corpus scoping: query does not cross corpora` scenario.
#[tokio::test]
async fn test_fulltext_corpus_scoping() {
    let pool = match maybe_pool().await {
        Some(p) => p,
        None => return,
    };

    let corpus_a = insert_corpus(&pool).await;
    let corpus_b = insert_corpus(&pool).await;
    let doc_a = insert_document(&pool, corpus_a, "scope-A-doc").await;
    let run = Uuid::new_v4().to_string().replace('-', "");
    let term = format!("xylophonez{}", &run[..8]);
    insert_block_tsv(&pool, doc_a, &term).await;

    // Search corpus B for the term that only exists in A.
    let in_b = fulltext_search(
        &pool,
        FullTextOptions {
            corpus_id: corpus_b,
            query_text: term.clone(),
            limit: 10,
        },
    )
    .await
    .expect("fulltext_search must succeed");
    assert!(
        in_b.is_empty(),
        "corpus B search must not see corpus A's block"
    );

    // Sanity: the term IS findable in corpus A.
    let in_a = fulltext_search(
        &pool,
        FullTextOptions {
            corpus_id: corpus_a,
            query_text: term.clone(),
            limit: 10,
        },
    )
    .await
    .expect("fulltext_search must succeed");
    assert!(!in_a.is_empty(), "corpus A search must see its own block");

    cleanup_corpus(&pool, corpus_a).await;
    cleanup_corpus(&pool, corpus_b).await;
}

// ── Test 10: semantic corpus scoping ────────────────────────────────────────────

/// Semantic search is scoped to its corpus: an embedded block in corpus A is
/// never returned by a semantic query issued against corpus B.
#[tokio::test]
async fn test_semantic_corpus_scoping() {
    let pool = match maybe_pool().await {
        Some(p) => p,
        None => return,
    };

    let embedder = Embedder::new().expect("embedder init failed");
    let corpus_a = insert_corpus(&pool).await;
    let corpus_b = insert_corpus(&pool).await;
    let doc_a = insert_document(&pool, corpus_a, "sem-scope-A").await;
    let block_a = insert_block_embedded(
        &pool,
        doc_a,
        "Rust is a systems programming language focused on safety.",
        &embedder,
    )
    .await;

    let in_b = semantic_search(
        &pool,
        &embedder,
        SemanticOptions {
            corpus_id: corpus_b,
            query_text: "systems programming language".into(),
            limit: 10,
        },
    )
    .await
    .expect("semantic_search must succeed");
    assert!(
        in_b.iter().all(|r| r.block_id != block_a),
        "corpus B semantic search must not return corpus A's block"
    );

    let in_a = semantic_search(
        &pool,
        &embedder,
        SemanticOptions {
            corpus_id: corpus_a,
            query_text: "systems programming language".into(),
            limit: 10,
        },
    )
    .await
    .expect("semantic_search must succeed");
    assert!(
        in_a.iter().any(|r| r.block_id == block_a),
        "corpus A semantic search must return its own block"
    );

    cleanup_corpus(&pool, corpus_a).await;
    cleanup_corpus(&pool, corpus_b).await;
}

// ── Test 11: graph layer filter (port of graph-cypher.test.ts, CTE version) ─────

/// Graph traversal honours the `layers` filter: a `structural`-only traversal
/// reaches a structurally-linked neighbour but not one linked via a `semantic`
/// edge.
///
/// Ports the layer-filter intent of the AGE `graph-cypher` suite onto the
/// recursive-CTE `graph_search`.
#[tokio::test]
async fn test_graph_layer_filter() {
    let pool = match maybe_pool().await {
        Some(p) => p,
        None => return,
    };

    let corpus_id = insert_corpus(&pool).await;
    let doc_id = insert_document(&pool, corpus_id, "graph-layer-doc").await;
    let a = insert_block_bare(&pool, doc_id, "Block A").await;
    let b = insert_block_bare(&pool, doc_id, "Block B").await;
    let c = insert_block_bare(&pool, doc_id, "Block C").await;
    insert_link(&pool, a, b, "structural").await;
    insert_link(&pool, a, c, "semantic").await;

    let results = graph_search(
        &pool,
        GraphOptions {
            seed_block_id: a,
            max_hops: 3,
            layers: vec!["structural".into()],
            limit: 10,
        },
    )
    .await
    .expect("graph_search must succeed");

    let ids: Vec<Uuid> = results.iter().map(|r| r.block_id).collect();
    assert!(ids.contains(&b), "structural neighbour B must be reachable");
    assert!(
        !ids.contains(&c),
        "semantic neighbour C must be excluded by the structural-only filter"
    );

    cleanup_corpus(&pool, corpus_id).await;
}

// ── Test 12: graph max_hops bound (port of graph-cypher.test.ts) ────────────────

/// Graph traversal honours `max_hops`: with `max_hops = 1` only depth-1
/// neighbours appear; the two-hop block is excluded.  Raising the bound to 2
/// then includes it at depth 2.
#[tokio::test]
async fn test_graph_max_hops_bound() {
    let pool = match maybe_pool().await {
        Some(p) => p,
        None => return,
    };

    let corpus_id = insert_corpus(&pool).await;
    let doc_id = insert_document(&pool, corpus_id, "graph-hops-doc").await;
    let a = insert_block_bare(&pool, doc_id, "Hop block A").await;
    let b = insert_block_bare(&pool, doc_id, "Hop block B").await;
    let c = insert_block_bare(&pool, doc_id, "Hop block C").await;
    insert_link(&pool, a, b, "structural").await;
    insert_link(&pool, b, c, "structural").await;

    let one_hop = graph_search(
        &pool,
        GraphOptions {
            seed_block_id: a,
            max_hops: 1,
            layers: vec!["structural".into()],
            limit: 10,
        },
    )
    .await
    .expect("graph_search must succeed");
    let one_ids: Vec<Uuid> = one_hop.iter().map(|r| r.block_id).collect();
    assert!(one_ids.contains(&b), "B is one hop away");
    assert!(!one_ids.contains(&c), "C (two hops) must be excluded at max_hops=1");

    let two_hop = graph_search(
        &pool,
        GraphOptions {
            seed_block_id: a,
            max_hops: 2,
            layers: vec!["structural".into()],
            limit: 10,
        },
    )
    .await
    .expect("graph_search must succeed");
    let c_res = two_hop.iter().find(|r| r.block_id == c);
    assert!(c_res.is_some(), "C must be reachable at max_hops=2");
    assert_eq!(c_res.unwrap().depth, 2, "C must be at depth 2");

    cleanup_corpus(&pool, corpus_id).await;
}

// ── Test 13: hybrid_search (previously untested public fn) ──────────────────────

/// Hybrid search combines a semantic seed with one-hop graph expansion: the
/// embedded seed block appears (tagged `semantic`) and its structural neighbour
/// appears (tagged `graph`), with no duplicate block ids.
#[tokio::test]
async fn test_hybrid_search_combines_and_dedups() {
    let pool = match maybe_pool().await {
        Some(p) => p,
        None => return,
    };

    let embedder = Embedder::new().expect("embedder init failed");
    let corpus_id = insert_corpus(&pool).await;
    let doc_id = insert_document(&pool, corpus_id, "hybrid-doc").await;
    let seed = insert_block_embedded(
        &pool,
        doc_id,
        "Rust memory safety and the ownership model.",
        &embedder,
    )
    .await;
    let neighbor = insert_block_bare(&pool, doc_id, "Borrowing and lifetimes detail").await;
    insert_link(&pool, seed, neighbor, "structural").await;

    let results = hybrid_search(
        &pool,
        &embedder,
        HybridOptions {
            corpus_id,
            query_text: "memory safety".into(),
            limit: 20,
        },
    )
    .await
    .expect("hybrid_search must succeed");

    // No duplicate block ids.
    let ids: Vec<Uuid> = results.iter().map(|r| r.block_id).collect();
    let unique: std::collections::HashSet<Uuid> = ids.iter().copied().collect();
    assert_eq!(ids.len(), unique.len(), "hybrid results must be deduplicated");

    let seed_hit = results.iter().find(|r| r.block_id == seed);
    assert!(seed_hit.is_some(), "semantic seed block must appear");
    assert_eq!(
        seed_hit.unwrap().origin.as_deref(),
        Some("semantic"),
        "seed must be tagged 'semantic'"
    );

    let graph_hit = results.iter().find(|r| r.block_id == neighbor);
    assert!(graph_hit.is_some(), "graph neighbour must appear");
    assert_eq!(
        graph_hit.unwrap().origin.as_deref(),
        Some("graph"),
        "neighbour must be tagged 'graph'"
    );

    cleanup_corpus(&pool, corpus_id).await;
}

// ── Test 14: edge_embedding vector search (from #23) ────────────────────────────

/// Edge-semantic search retrieves the nearest typed link by its
/// `edge_embedding`, scoped to the corpus and filtered by layer.  Endpoints
/// round-trip on the result.
#[tokio::test]
async fn test_edge_semantic_search_returns_nearest_link() {
    let pool = match maybe_pool().await {
        Some(p) => p,
        None => return,
    };

    let embedder = Embedder::new().expect("embedder init failed");
    let corpus_id = insert_corpus(&pool).await;
    let doc_id = insert_document(&pool, corpus_id, "edge-doc").await;
    let src = insert_block_bare(&pool, doc_id, "Payment is due under Section 4").await;
    let dst = insert_block_bare(&pool, doc_id, "Section 4 governs the fees").await;

    let edge_vec = embed_edge(
        &embedder,
        "Payment is due under Section 4",
        "Section 4 governs the fees",
        Some("cites"),
    )
    .expect("embed_edge must succeed");

    let link_id = Uuid::new_v4();
    sqlx::query(
        r#"INSERT INTO nexum.links (id, src, dst, layer, rel_type, weight, provenance, edge_embedding)
           VALUES ($1, $2, $3, 'structural', 'cites', 1.0, '{}'::jsonb, $4::vector)"#,
    )
    .bind(link_id)
    .bind(src)
    .bind(dst)
    .bind(&edge_vec)
    .execute(&pool)
    .await
    .expect("link insert failed");

    let results = edge_semantic_search(
        &pool,
        &embedder,
        EdgeSemanticOptions {
            corpus_id,
            probe: EdgeProbe::Text("cites: payment -> fees".into()),
            layers: vec!["structural".into()],
            limit: 10,
        },
    )
    .await
    .expect("edge_semantic_search must succeed");

    assert!(!results.is_empty(), "expected at least one edge result");
    assert_eq!(results[0].link_id, link_id);
    assert_eq!(results[0].src.block_id, src);
    assert_eq!(results[0].dst.block_id, dst);
    assert_eq!(results[0].rel_type.as_deref(), Some("cites"));
    assert!(results[0].score > 0.0, "score must be positive");

    cleanup_corpus(&pool, corpus_id).await;
}

// ── Test 15: migration creates tables (port of ingest-query.test.ts) ────────────

/// All core `nexum.*` tables exist after migrations are applied.  Ports the TS
/// `migration creates all required tables` scenario (TS used the `public`
/// schema; this crate namespaces them under `nexum`).
#[tokio::test]
async fn test_migration_creates_tables() {
    let pool = match maybe_pool().await {
        Some(p) => p,
        None => return,
    };

    let names: Vec<String> = sqlx::query_scalar(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'nexum' ORDER BY tablename",
    )
    .fetch_all(&pool)
    .await
    .expect("pg_tables query failed");

    for required in [
        "corpora",
        "documents",
        "document_versions",
        "blocks",
        "version_blocks",
        "links",
        "entities",
        "relations",
        "job_queue",
    ] {
        assert!(
            names.iter().any(|n| n == required),
            "nexum schema must contain table '{required}' (found: {names:?})"
        );
    }
}

// ── Test 16: ai_link classify_pair (from #22, pure unit test — NOT DB-gated) ────

/// The keyword-heuristic relation classifier behaves per `ai.ts`'s
/// `classifyPair`.  This is a pure function with no DB dependency, so it is NOT
/// `#[ignore]`'d and runs in every `cargo test` invocation.
///
/// (The exhaustive boundary/keyword matrix lives in `src/ai_link.rs`'s unit
/// tests; this asserts the library-public surface from an integration crate.)
#[test]
fn test_classify_pair_public_surface() {
    // Below threshold -> None.
    assert_eq!(classify_pair("similarly, it also confirms", 0.69), None);
    // First matching signal in priority order wins (contradicts > supports).
    assert_eq!(
        classify_pair("however, this is similarly true", 0.9),
        Some("contradicts")
    );
    // Case-insensitive keyword match.
    assert_eq!(
        classify_pair("HOWEVER the rule differs", 0.75),
        Some("contradicts")
    );
    // High similarity with no keyword falls back to "supports".
    assert_eq!(classify_pair("plain unrelated text", 0.86), Some("supports"));
    // Mid similarity with no keyword -> None.
    assert_eq!(classify_pair("plain unrelated text", 0.80), None);
    // Trailing-space keyword "not " must not match the substring inside "notion".
    assert_eq!(classify_pair("a notion of fairness", 0.80), None);
}
