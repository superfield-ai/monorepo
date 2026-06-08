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

use nexum::ai_link::process_ai_links;
use nexum::dedup::content_hash;
use nexum::embed::Embedder;
use nexum::parse::Format;
use nexum::{
    edge_semantic_search, error_to_cause_chain, fulltext_search, graph_search, ingest_document,
    semantic_search, EdgeProbe, EdgeSemanticOptions, FullTextOptions, GraphOptions, IngestOptions,
    SemanticOptions,
};
use sqlx::PgPool;
use uuid::Uuid;

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

/// Insert a workspace and return its UUID.
async fn insert_workspace(pool: &PgPool) -> Uuid {
    sqlx::query_scalar(
        r#"INSERT INTO public.workspaces (slug, display_name) VALUES ($1, $2) RETURNING id"#,
    )
    .bind(format!("nexum-test-ws-{}", Uuid::new_v4()))
    .bind("Nexum Integration Test Workspace")
    .fetch_one(pool)
    .await
    .expect("workspace insert failed")
}

/// Insert a test corpus scoped to `workspace_id` and return its UUID.
async fn insert_corpus(pool: &PgPool, workspace_id: Uuid) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO nexum.corpora (workspace_id, name) VALUES ($1, $2) RETURNING id",
    )
    .bind(workspace_id)
    .bind(format!("nexum-test-corpus-{}", Uuid::new_v4()))
    .fetch_one(pool)
    .await
    .expect("corpus insert failed")
}

/// Insert a bare block (no embedding, no tsv) in `nexum.blocks`.
async fn insert_block_bare(pool: &PgPool, doc_id: Uuid, workspace_id: Uuid, content: &str) -> Uuid {
    let hash = content_hash(content);
    sqlx::query_scalar(
        r#"INSERT INTO nexum.blocks (workspace_id, doc_id, content, content_hash, block_type)
           VALUES ($1, $2, $3, $4, 'paragraph') RETURNING id"#,
    )
    .bind(workspace_id)
    .bind(doc_id)
    .bind(content)
    .bind(hash)
    .fetch_one(pool)
    .await
    .expect("bare block insert failed")
}

/// Insert a link in `nexum.links`.
async fn insert_link(pool: &PgPool, src: Uuid, dst: Uuid, workspace_id: Uuid, layer: &str) -> Uuid {
    let link_id = Uuid::new_v4();
    sqlx::query(
        r#"INSERT INTO nexum.links (id, workspace_id, src, dst, layer, rel_type, weight, provenance)
           VALUES ($1, $2, $3, $4, $5, 'cites', 1.0, '{}'::jsonb)"#,
    )
    .bind(link_id)
    .bind(workspace_id)
    .bind(src)
    .bind(dst)
    .bind(layer)
    .execute(pool)
    .await
    .expect("link insert failed");
    link_id
}

/// Insert an entity into the `nexum.entities` table.
async fn insert_entity(
    pool: &PgPool,
    workspace_id: Uuid,
    entity_type: &str,
    props: serde_json::Value,
) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO nexum.entities (workspace_id, type, properties) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(workspace_id)
    .bind(entity_type)
    .bind(props)
    .fetch_one(pool)
    .await
    .expect("entity insert failed")
}

/// Insert a relation into the `nexum.relations` table.
async fn insert_relation(
    pool: &PgPool,
    workspace_id: Uuid,
    source_id: Uuid,
    target_id: Uuid,
    rel_type: &str,
) {
    sqlx::query(
        "INSERT INTO nexum.relations (workspace_id, source_id, target_id, type) VALUES ($1, $2, $3, $4)",
    )
    .bind(workspace_id)
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
    let workspace_id = insert_workspace(&pool).await;
    let corpus_id = insert_corpus(&pool, workspace_id).await;

    let content = "The quick brown fox.\n\nSecond paragraph here.";
    let result = ingest_document(
        &pool,
        &embedder,
        IngestOptions {
            workspace_id,
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

// ── Test: AI linker + edge-semantic search ────────────────────────────────────

/// Ingest two near-paraphrase blocks (one carrying a `contradicts` keyword),
/// run the AI linker, and verify it writes a `layer = 'ai'` edge with a
/// populated edge embedding that `edge_semantic_search` can retrieve.
///
/// Exercises the full #48b path: `process_ai_links` (pgvector ANN self-join +
/// keyword classification + `embed_edge`) and `edge_semantic_search`.
#[tokio::test]
async fn test_ai_linker_and_edge_semantic_search() {
    let pool = match maybe_pool().await {
        Some(p) => p,
        None => return,
    };

    let embedder = Embedder::new().expect("embedder init failed");
    let workspace_id = insert_workspace(&pool).await;
    let corpus_id = insert_corpus(&pool, workspace_id).await;

    // Two near-identical paragraphs (high cosine similarity); the second opens
    // with "However" so `classify_pair` tags the edge as `contradicts`.
    let content = "The annual budget allocates funds to public infrastructure across the region.\n\n\
                   However, the annual budget allocates funds to public infrastructure across the region.";
    let result = ingest_document(
        &pool,
        &embedder,
        IngestOptions {
            workspace_id,
            corpus_id,
            title: format!("ai-link-test-{}", Uuid::new_v4()),
            content: content.into(),
            format: Format::Text,
            external_id: None,
        },
    )
    .await
    .expect("ingest must succeed");
    assert!(result.block_count >= 2, "expected two blocks to link");

    // Run the AI linker over the ingested version.
    process_ai_links(&pool, &embedder, result.version_id)
        .await
        .expect("process_ai_links must succeed");

    // At least one `ai` edge with a populated edge embedding must exist, scoped
    // to this workspace.
    let ai_edges: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*) FROM nexum.links
           WHERE layer = 'ai' AND workspace_id = $1 AND edge_embedding IS NOT NULL"#,
    )
    .bind(workspace_id)
    .fetch_one(&pool)
    .await
    .expect("ai-edge count query failed");
    assert!(ai_edges >= 1, "AI linker must write at least one ai edge");

    // Edge-semantic search must retrieve at least one of those edges.
    let results = edge_semantic_search(
        &pool,
        &embedder,
        EdgeSemanticOptions {
            corpus_id,
            probe: EdgeProbe::Text("budget infrastructure funding".into()),
            layers: vec!["ai".into()],
            limit: 10,
        },
    )
    .await
    .expect("edge_semantic_search must succeed");
    assert!(
        !results.is_empty(),
        "edge_semantic_search must return the ai edge"
    );
    assert!(
        results.iter().all(|r| r.layer == "ai"),
        "layer filter must restrict to ai edges"
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
    let workspace_id = insert_workspace(&pool).await;
    let corpus_id = insert_corpus(&pool, workspace_id).await;

    // Use a highly distinctive phrase unlikely to collide with other test data.
    let run_id = Uuid::new_v4().to_string().replace('-', "");
    let distinctive = format!("zxqvft{} is a unique test phrase", &run_id[..8]);
    let content = distinctive.clone();

    ingest_document(
        &pool,
        &embedder,
        IngestOptions {
            workspace_id,
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
            workspace_id,
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
    let workspace_id = insert_workspace(&pool).await;
    let corpus_id = insert_corpus(&pool, workspace_id).await;

    ingest_document(
        &pool,
        &embedder,
        IngestOptions {
            workspace_id,
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
            workspace_id,
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

    let workspace_id = insert_workspace(&pool).await;
    let corpus_id = insert_corpus(&pool, workspace_id).await;

    // Insert a bare document so blocks have a valid doc_id.
    let doc_id: Uuid = sqlx::query_scalar(
        "INSERT INTO nexum.documents (workspace_id, corpus_id, title) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(workspace_id)
    .bind(corpus_id)
    .bind(format!("graph-test-doc-{}", Uuid::new_v4()))
    .fetch_one(&pool)
    .await
    .expect("document insert failed");

    let src_id =
        insert_block_bare(&pool, doc_id, workspace_id, "Graph source block for test").await;
    let dst_id = insert_block_bare(
        &pool,
        doc_id,
        workspace_id,
        "Graph destination block for test",
    )
    .await;
    insert_link(&pool, src_id, dst_id, workspace_id, "structural").await;

    let results = graph_search(
        &pool,
        GraphOptions {
            workspace_id,
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
    let workspace_id = insert_workspace(&pool).await;

    let error_id = insert_entity(
        &pool,
        workspace_id,
        "error",
        serde_json::json!({"message": format!("test-error-{}", run_tag)}),
    )
    .await;
    let session_id = insert_entity(
        &pool,
        workspace_id,
        "session",
        serde_json::json!({"run": run_tag.clone()}),
    )
    .await;
    let user_id = insert_entity(
        &pool,
        workspace_id,
        "user",
        serde_json::json!({"name": format!("test-user-{}", run_tag)}),
    )
    .await;
    let req_id = insert_entity(
        &pool,
        workspace_id,
        "requirement",
        serde_json::json!({"title": format!("test-req-{}", run_tag)}),
    )
    .await;
    let code_id = insert_entity(
        &pool,
        workspace_id,
        "code",
        serde_json::json!({"path": format!("src/{}.rs", run_tag)}),
    )
    .await;

    // Wire the chain: error→session→user, session→requirement→code.
    insert_relation(&pool, workspace_id, error_id, session_id, "caused_in").await;
    insert_relation(&pool, workspace_id, session_id, user_id, "initiated_by").await;
    insert_relation(&pool, workspace_id, session_id, req_id, "fulfills").await;
    insert_relation(&pool, workspace_id, req_id, code_id, "implemented_by").await;

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
    let workspace_id = insert_workspace(&pool).await;

    let error_id = insert_entity(
        &pool,
        workspace_id,
        "error",
        serde_json::json!({"message": format!("partial-error-{}", run_tag)}),
    )
    .await;
    let session_id = insert_entity(
        &pool,
        workspace_id,
        "session",
        serde_json::json!({"run": run_tag.clone()}),
    )
    .await;

    // Only the error→session hop; no user/requirement/code links.
    insert_relation(&pool, workspace_id, error_id, session_id, "caused_in").await;

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
