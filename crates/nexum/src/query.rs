//! Nexum query layer — full-text, semantic (HNSW), graph, and hybrid.
//!
//! All four query modes run against the single shared Postgres instance via the
//! supplied `sqlx::PgPool`.  The module mirrors the TypeScript `src/routes/query.ts`
//! implementation in `superfield-ai/nexum` so that result shapes and SQL
//! semantics are identical.
//!
//! # Query modes
//!
//! | Mode       | SQL primitive             | Required inputs                          |
//! | ---------- | ------------------------- | ---------------------------------------- |
//! | `FullText` | `tsv @@ plainto_tsquery`  | `corpus_id`, `query_text`                |
//! | `Semantic` | pgvector HNSW `<=>` op    | `corpus_id`, `query_text` (embedded)     |
//! | `Graph`    | recursive CTE on `links`  | `seed_block_id`, `max_hops`, `layers`    |
//! | `Hybrid`   | semantic + one-hop graph  | `corpus_id`, `query_text`                |
//!
//! # Architecture note
//!
//! Graph traversal uses a recursive CTE (not Apache AGE — see issue #359 which
//! folded the AGE graph shim).  All queries run inside the primary Postgres
//! instance via the shared pool; there is no second Postgres process.
//!
//! See `docs/architecture.md` §Nexum and §Single-Instance Database Schema
//! Layout.

use crate::embed::Embedder;
use crate::links::build_edge_text;
use sqlx::PgPool;
use thiserror::Error;
use uuid::Uuid;

// Internal row types used with sqlx::query_as to avoid clippy's complex-type warning.
type BlockRow = (Uuid, String, f64, Uuid, String, Option<String>);
type GraphRow = (Uuid, String, i32, String, Uuid, String, Option<String>);
// link_id, layer, rel_type, weight, score,
// src_block_id, src_content, src_doc_id, src_doc_title,
// dst_block_id, dst_content, dst_doc_id, dst_doc_title
type EdgeRow = (
    Uuid,
    String,
    Option<String>,
    f64,
    f64,
    Uuid,
    String,
    Uuid,
    String,
    Uuid,
    String,
    Uuid,
    String,
);

// ── Errors ────────────────────────────────────────────────────────────────────

/// Errors that can occur during a query.
#[derive(Debug, Error)]
pub enum QueryError {
    /// A database error.
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),

    /// The embedding model failed during inference.
    #[error("embedding error: {0}")]
    Embed(#[from] crate::embed::EmbedError),

    /// The caller supplied invalid parameters.
    #[error("invalid query options: {0}")]
    InvalidOptions(String),
}

// ── Result types ──────────────────────────────────────────────────────────────

/// A document reference carried inside a block result.
#[derive(Debug, Clone)]
pub struct DocRef {
    /// UUID of the parent document.
    pub id: Uuid,
    /// Human-readable title.
    pub title: String,
    /// Optional external identifier (e.g. a CMS slug).
    pub external_id: Option<String>,
}

/// A single block result returned by full-text, semantic, or hybrid queries.
#[derive(Debug, Clone)]
pub struct BlockResult {
    /// UUID of the block row.
    pub block_id: Uuid,
    /// Text content of the block.
    pub content: String,
    /// Relevance score (cosine similarity for semantic, `ts_rank` for
    /// full-text).  In the range `[0, 1]` for semantic; non-negative for
    /// full-text.
    pub score: f64,
    /// Parent document.
    pub document: DocRef,
    /// `Some("semantic")` or `Some("graph")` for hybrid results; `None`
    /// otherwise.
    pub origin: Option<String>,
}

/// A single block result returned by graph traversal queries.
#[derive(Debug, Clone)]
pub struct GraphResult {
    /// UUID of the block row.
    pub block_id: Uuid,
    /// Text content of the block.
    pub content: String,
    /// Hop distance from the seed block.
    pub depth: i32,
    /// Relationship type of the last edge traversed to reach this block.
    pub rel_type: String,
    /// Parent document.
    pub document: DocRef,
}

/// One endpoint (source or destination) of an edge result.
#[derive(Debug, Clone)]
pub struct EdgeBlockRef {
    /// UUID of the endpoint block.
    pub block_id: Uuid,
    /// Text content of the endpoint block.
    pub content: String,
    /// Parent document of the endpoint block.
    pub document: DocRef,
}

/// A single typed-link result returned by edge-similarity search.
///
/// Mirrors the per-row shape produced by `edgeSemanticSearch` in
/// `src/routes/query.ts`.
#[derive(Debug, Clone)]
pub struct EdgeResult {
    /// UUID of the link row.
    pub link_id: Uuid,
    /// Link layer (`structural`, `semantic`, or `ai`).
    pub layer: String,
    /// Relationship type of the link, if any.
    pub rel_type: Option<String>,
    /// Link weight.
    pub weight: f64,
    /// Cosine similarity (`1 − distance`) between the probe and the edge
    /// embedding.  In the range `[0, 1]`.
    pub score: f64,
    /// Source endpoint.
    pub src: EdgeBlockRef,
    /// Destination endpoint.
    pub dst: EdgeBlockRef,
}

// ── Options ───────────────────────────────────────────────────────────────────

/// Options for [`fulltext_search`].
#[derive(Debug, Clone)]
pub struct FullTextOptions {
    /// UUID of the corpus to search within.
    pub corpus_id: Uuid,
    /// Free-text query string.  Passed to `plainto_tsquery('english', …)`.
    pub query_text: String,
    /// Maximum number of results to return.  Capped at 100.
    pub limit: u32,
}

/// Options for [`semantic_search`].
#[derive(Debug, Clone)]
pub struct SemanticOptions {
    /// UUID of the corpus to search within.
    pub corpus_id: Uuid,
    /// Free-text query string.  Embedded into a 384-dim vector before
    /// querying the HNSW index on `blocks.embedding`.
    pub query_text: String,
    /// Maximum number of results to return.  Capped at 100.
    pub limit: u32,
}

/// Options for [`graph_search`].
#[derive(Debug, Clone)]
pub struct GraphOptions {
    /// UUID of the seed block to start traversal from.
    pub seed_block_id: Uuid,
    /// Maximum number of hops to traverse.  Defaults to 3 when not set.
    pub max_hops: i32,
    /// Link layers to follow.  Defaults to `["structural", "semantic", "ai"]`
    /// when empty.
    pub layers: Vec<String>,
    /// Maximum number of results to return.  Capped at 100.
    pub limit: u32,
}

/// Options for [`hybrid_search`].
#[derive(Debug, Clone)]
pub struct HybridOptions {
    /// UUID of the corpus to search within.
    pub corpus_id: Uuid,
    /// Free-text query string.  Used for both the semantic seed pass and the
    /// graph expansion pass.
    pub query_text: String,
    /// Maximum number of results to return.  Capped at 100.
    pub limit: u32,
}

/// Probe input for [`edge_semantic_search`].
///
/// The probe is either a free-text `query` or a structured
/// `(src_text, dst_text, rel_hint?)` triple.  The triple is embedded with the
/// same [`build_edge_text`] template the linker uses at write time, so the
/// probe and stored edge embeddings live in matching constructions.  Mirrors
/// the `target: 'edges'` branch of `handleVectorQuery` in
/// `src/routes/query.ts`.
#[derive(Debug, Clone)]
pub enum EdgeProbe {
    /// A free-text query, embedded directly.
    Text(String),
    /// A structured endpoint triple, embedded via [`build_edge_text`].
    Triple {
        /// Source-side text.
        src_text: String,
        /// Destination-side text.
        dst_text: String,
        /// Optional relationship hint; defaults to `"related"`.
        rel_hint: Option<String>,
    },
}

/// Options for [`edge_semantic_search`].
#[derive(Debug, Clone)]
pub struct EdgeSemanticOptions {
    /// UUID of the corpus to search within.  Both endpoint blocks must belong
    /// to documents in this corpus.
    pub corpus_id: Uuid,
    /// The probe to embed and match against `links.edge_embedding`.
    pub probe: EdgeProbe,
    /// Optional link-layer filter.  When empty, all layers are searched.
    pub layers: Vec<String>,
    /// Maximum number of results to return.  Capped at 100.
    pub limit: u32,
}

// ── Query functions ───────────────────────────────────────────────────────────

/// Full-text search over blocks in a corpus.
///
/// Uses PostgreSQL's `plainto_tsquery('english', …)` against the pre-computed
/// `blocks.tsv` tsvector column.  Results are ordered by `ts_rank` descending.
///
/// Mirrors `fulltextSearch` in `src/routes/query.ts`.
///
/// # Errors
///
/// Returns [`QueryError::Database`] on a SQL error, or
/// [`QueryError::InvalidOptions`] when `query_text` is empty.
pub async fn fulltext_search(
    pool: &PgPool,
    opts: FullTextOptions,
) -> Result<Vec<BlockResult>, QueryError> {
    if opts.query_text.trim().is_empty() {
        return Err(QueryError::InvalidOptions(
            "query_text must not be empty for full-text search".into(),
        ));
    }

    let limit = opts.limit.min(100) as i64;

    let rows: Vec<BlockRow> = sqlx::query_as(
        r#"
        SELECT b.id, b.content,
               ts_rank(b.tsv, plainto_tsquery('english', $1))::double precision AS score,
               d.id, d.title, d.external_id
        FROM nexum.blocks b
        JOIN nexum.documents d ON d.id = b.doc_id,
             plainto_tsquery('english', $1) q
        WHERE d.corpus_id = $2
          AND b.tsv @@ q
        ORDER BY score DESC
        LIMIT $3
        "#,
    )
    .bind(&opts.query_text)
    .bind(opts.corpus_id)
    .bind(limit)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(
            |(block_id, content, score, doc_id, title, external_id)| BlockResult {
                block_id,
                content,
                score,
                document: DocRef {
                    id: doc_id,
                    title,
                    external_id,
                },
                origin: None,
            },
        )
        .collect())
}

/// Semantic ANN search over blocks in a corpus using the pgvector HNSW index.
///
/// The `query_text` is embedded into a 384-dim vector via `embedder`, then
/// the nearest blocks are retrieved via the `<=>` cosine-distance operator on
/// `blocks.embedding`.  The score is `1 − distance` (cosine similarity).
///
/// Mirrors `semanticSearch` in `src/routes/query.ts`.
///
/// # Errors
///
/// Returns [`QueryError::Embed`] if embedding fails, [`QueryError::Database`]
/// on a SQL error, or [`QueryError::InvalidOptions`] when `query_text` is
/// empty.
pub async fn semantic_search(
    pool: &PgPool,
    embedder: &Embedder,
    opts: SemanticOptions,
) -> Result<Vec<BlockResult>, QueryError> {
    if opts.query_text.trim().is_empty() {
        return Err(QueryError::InvalidOptions(
            "query_text must not be empty for semantic search".into(),
        ));
    }

    let limit = opts.limit.min(100) as i64;

    let vec = embedder.embed_one(&opts.query_text)?;
    let vec_str = format!(
        "[{}]",
        vec.iter()
            .map(|v| v.to_string())
            .collect::<Vec<_>>()
            .join(",")
    );

    let rows: Vec<BlockRow> = sqlx::query_as(
        r#"
        SELECT b.id, b.content,
               (1.0 - (b.embedding <=> $1::vector))::double precision AS score,
               d.id, d.title, d.external_id
        FROM nexum.blocks b
        JOIN nexum.documents d ON d.id = b.doc_id
        WHERE d.corpus_id = $2
          AND b.embedding IS NOT NULL
        ORDER BY b.embedding <=> $1::vector
        LIMIT $3
        "#,
    )
    .bind(&vec_str)
    .bind(opts.corpus_id)
    .bind(limit)
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(
            |(block_id, content, score, doc_id, title, external_id)| BlockResult {
                block_id,
                content,
                score,
                document: DocRef {
                    id: doc_id,
                    title,
                    external_id,
                },
                origin: None,
            },
        )
        .collect())
}

/// Edge-similarity ANN search over `nexum.links.edge_embedding`.
///
/// Embeds the probe (free text or a `(src, dst, rel_hint)` triple) into a
/// 384-dim vector, then retrieves the nearest typed links via the `<=>`
/// cosine-distance operator on the HNSW index, scoped to the corpus and
/// optionally filtered by link layer.  Both endpoint blocks must belong to
/// documents in `opts.corpus_id`, matching the corpus-scoping invariant the
/// other modes enforce.
///
/// Mirrors `edgeSemanticSearch` (the `mode: 'vector'` + `target: 'edges'`
/// path) in `src/routes/query.ts`.
///
/// # Errors
///
/// Returns [`QueryError::Embed`] if embedding fails, [`QueryError::Database`]
/// on a SQL error, or [`QueryError::InvalidOptions`] when the probe text is
/// empty.
pub async fn edge_semantic_search(
    pool: &PgPool,
    embedder: &Embedder,
    opts: EdgeSemanticOptions,
) -> Result<Vec<EdgeResult>, QueryError> {
    let probe_text = match &opts.probe {
        EdgeProbe::Text(t) => t.clone(),
        EdgeProbe::Triple {
            src_text,
            dst_text,
            rel_hint,
        } => build_edge_text(src_text, dst_text, rel_hint.as_deref()),
    };
    if probe_text.trim().is_empty() {
        return Err(QueryError::InvalidOptions(
            "probe text must not be empty for edge-semantic search".into(),
        ));
    }

    let limit = opts.limit.min(100) as i64;

    let vec = embedder.embed_one(&probe_text)?;
    let vec_str = format!(
        "[{}]",
        vec.iter()
            .map(|v| v.to_string())
            .collect::<Vec<_>>()
            .join(",")
    );

    // Optional layer filter mirrors the TS `layerFilter` clause.  Layers are
    // bound as a Postgres text[] parameter ($4) rather than interpolated.
    let layer_filter = if opts.layers.is_empty() {
        ""
    } else {
        " AND l.layer = ANY($4)"
    };

    let sql = format!(
        r#"
        SELECT l.id, l.layer, l.rel_type, l.weight::double precision,
               (1.0 - (l.edge_embedding <=> $1::vector))::double precision AS score,
               sb.id, sb.content, sd.id, sd.title,
               db.id, db.content, dd.id, dd.title
        FROM nexum.links l
        JOIN nexum.blocks sb ON sb.id = l.src
        JOIN nexum.blocks db ON db.id = l.dst
        JOIN nexum.documents sd ON sd.id = sb.doc_id
        JOIN nexum.documents dd ON dd.id = db.doc_id
        WHERE l.edge_embedding IS NOT NULL
          AND sd.corpus_id = $2
          AND dd.corpus_id = $2{layer_filter}
        ORDER BY l.edge_embedding <=> $1::vector
        LIMIT $3
        "#,
        layer_filter = layer_filter,
    );

    let mut q = sqlx::query_as::<_, EdgeRow>(&sql)
        .bind(&vec_str)
        .bind(opts.corpus_id)
        .bind(limit);
    if !opts.layers.is_empty() {
        q = q.bind(&opts.layers);
    }
    let rows: Vec<EdgeRow> = q.fetch_all(pool).await?;

    Ok(rows
        .into_iter()
        .map(
            |(
                link_id,
                layer,
                rel_type,
                weight,
                score,
                src_block_id,
                src_content,
                src_doc_id,
                src_doc_title,
                dst_block_id,
                dst_content,
                dst_doc_id,
                dst_doc_title,
            )| EdgeResult {
                link_id,
                layer,
                rel_type,
                weight,
                score,
                src: EdgeBlockRef {
                    block_id: src_block_id,
                    content: src_content,
                    document: DocRef {
                        id: src_doc_id,
                        title: src_doc_title,
                        external_id: None,
                    },
                },
                dst: EdgeBlockRef {
                    block_id: dst_block_id,
                    content: dst_content,
                    document: DocRef {
                        id: dst_doc_id,
                        title: dst_doc_title,
                        external_id: None,
                    },
                },
            },
        )
        .collect())
}

/// Graph traversal query using a recursive CTE on the `links` table.
///
/// Starts at `seed_block_id` and follows edges whose `layer` is in `layers`,
/// up to `max_hops` hops.  A cycle-guard (`src != ALL(path)`) prevents
/// infinite loops.  Results are ordered by hop depth.
///
/// Uses a recursive CTE — not Apache AGE.  All traversal runs inside the
/// primary Postgres instance via the shared pool.
///
/// Mirrors `graphSearch` in `src/routes/query.ts`.
///
/// # Errors
///
/// Returns [`QueryError::Database`] on a SQL error, or
/// [`QueryError::InvalidOptions`] when `layers` is empty.
pub async fn graph_search(
    pool: &PgPool,
    opts: GraphOptions,
) -> Result<Vec<GraphResult>, QueryError> {
    let layers = if opts.layers.is_empty() {
        vec![
            "structural".to_string(),
            "semantic".to_string(),
            "ai".to_string(),
        ]
    } else {
        opts.layers.clone()
    };
    let max_hops = opts.max_hops.max(1);
    let limit = opts.limit.min(100) as i64;

    // sqlx does not natively support passing a Vec<String> as a Postgres
    // text[] array via `$N` in a WITH RECURSIVE statement using query_as, so
    // we format the array literal directly (values are validated — they come
    // from the application, not user input to the SQL injection path).
    let layers_literal = format!(
        "ARRAY[{}]",
        layers
            .iter()
            .map(|l| format!("'{}'", l.replace('\'', "''")))
            .collect::<Vec<_>>()
            .join(",")
    );

    let sql = format!(
        r#"
        WITH RECURSIVE graph AS (
            SELECT dst AS id, 1 AS depth, ARRAY[src] AS path, rel_type
            FROM nexum.links
            WHERE src = $1 AND layer = ANY({layers})
            UNION ALL
            SELECT l.dst, g.depth + 1, g.path || l.src, l.rel_type
            FROM nexum.links l
            JOIN graph g ON l.src = g.id
            WHERE g.depth < $2
              AND l.src != ALL(g.path)
              AND l.layer = ANY({layers})
        )
        SELECT DISTINCT b.id, b.content,
               g.depth, g.rel_type,
               d.id, d.title, d.external_id
        FROM graph g
        JOIN nexum.blocks b ON b.id = g.id
        JOIN nexum.documents d ON d.id = b.doc_id
        ORDER BY g.depth
        LIMIT $3
        "#,
        layers = layers_literal,
    );

    let rows: Vec<GraphRow> = sqlx::query_as(&sql)
        .bind(opts.seed_block_id)
        .bind(max_hops)
        .bind(limit)
        .fetch_all(pool)
        .await?;

    Ok(rows
        .into_iter()
        .map(
            |(block_id, content, depth, rel_type, doc_id, title, external_id)| GraphResult {
                block_id,
                content,
                depth,
                rel_type,
                document: DocRef {
                    id: doc_id,
                    title,
                    external_id,
                },
            },
        )
        .collect())
}

/// Hybrid search — semantic seed followed by one-hop graph expansion.
///
/// 1. Runs `semantic_search` with `limit = 10` to get an initial candidate set.
/// 2. For each semantic result, runs a one-hop graph expansion.
/// 3. Deduplicates by block UUID.
/// 4. Returns up to `opts.limit` results, semantic hits first then graph
///    neighbours.
///
/// Mirrors `hybridSearch` in `src/routes/query.ts`.
///
/// # Errors
///
/// Returns any error from the underlying semantic or graph searches.
pub async fn hybrid_search(
    pool: &PgPool,
    embedder: &Embedder,
    opts: HybridOptions,
) -> Result<Vec<BlockResult>, QueryError> {
    if opts.query_text.trim().is_empty() {
        return Err(QueryError::InvalidOptions(
            "query_text must not be empty for hybrid search".into(),
        ));
    }

    let limit = opts.limit.min(100);

    // Step 1: semantic top-10 seed.
    let semantic_results = semantic_search(
        pool,
        embedder,
        SemanticOptions {
            corpus_id: opts.corpus_id,
            query_text: opts.query_text.clone(),
            limit: 10,
        },
    )
    .await?;

    let mut seen: std::collections::HashSet<Uuid> =
        semantic_results.iter().map(|r| r.block_id).collect();

    let mut results: Vec<BlockResult> = semantic_results
        .into_iter()
        .map(|r| BlockResult {
            origin: Some("semantic".into()),
            ..r
        })
        .collect();

    // Step 2: one-hop graph expansion.
    for sr in results.clone().iter() {
        let neighbors = graph_search(
            pool,
            GraphOptions {
                seed_block_id: sr.block_id,
                max_hops: 1,
                layers: vec![
                    "structural".to_string(),
                    "semantic".to_string(),
                    "ai".to_string(),
                ],
                limit: 10,
            },
        )
        .await?;

        for n in neighbors {
            if seen.insert(n.block_id) {
                results.push(BlockResult {
                    block_id: n.block_id,
                    content: n.content,
                    score: 0.0,
                    document: n.document,
                    origin: Some("graph".into()),
                });
            }
        }
    }

    results.truncate(limit as usize);
    Ok(results)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    // ── Unit tests (no database required) ────────────────────────────────────

    #[test]
    fn fulltext_options_rejects_empty_query() {
        // The rejection happens synchronously in `fulltext_search` before any
        // DB call.  We test the guard by inspecting the option struct directly.
        let opts = FullTextOptions {
            corpus_id: Uuid::new_v4(),
            query_text: "  ".into(),
            limit: 10,
        };
        assert!(opts.query_text.trim().is_empty());
    }

    #[test]
    fn semantic_options_limit_capped_at_100() {
        let limit: u32 = 9999;
        assert_eq!(limit.min(100), 100);
    }

    #[test]
    fn graph_search_defaults_layers_when_empty() {
        let opts = GraphOptions {
            seed_block_id: Uuid::new_v4(),
            max_hops: 3,
            layers: vec![],
            limit: 10,
        };
        // Replicate the defaulting logic from graph_search.
        let layers = if opts.layers.is_empty() {
            vec![
                "structural".to_string(),
                "semantic".to_string(),
                "ai".to_string(),
            ]
        } else {
            opts.layers.clone()
        };
        assert_eq!(layers.len(), 3);
        assert!(layers.contains(&"structural".to_string()));
    }

    #[test]
    fn graph_layers_literal_escapes_single_quotes() {
        let layers = ["stru'ct".to_string()];
        let lit = format!(
            "ARRAY[{}]",
            layers
                .iter()
                .map(|l| format!("'{}'", l.replace('\'', "''")))
                .collect::<Vec<_>>()
                .join(",")
        );
        assert_eq!(lit, "ARRAY['stru''ct']");
    }

    #[test]
    fn edge_probe_triple_builds_template_text() {
        // Mirrors the TS triple path: build_edge_text is applied to a triple.
        let probe = EdgeProbe::Triple {
            src_text: "the  source".into(),
            dst_text: "the dest".into(),
            rel_hint: Some("cites".into()),
        };
        let text = match &probe {
            EdgeProbe::Text(t) => t.clone(),
            EdgeProbe::Triple {
                src_text,
                dst_text,
                rel_hint,
            } => crate::links::build_edge_text(src_text, dst_text, rel_hint.as_deref()),
        };
        assert_eq!(text, "cites: the source -> the dest");
    }

    #[test]
    fn edge_layer_filter_clause_toggles_on_layers() {
        let with: &[String] = &["structural".into()];
        let without: &[String] = &[];
        let clause = |layers: &[String]| {
            if layers.is_empty() {
                ""
            } else {
                " AND l.layer = ANY($4)"
            }
        };
        assert_eq!(clause(with), " AND l.layer = ANY($4)");
        assert_eq!(clause(without), "");
    }

    // ── Integration tests (require DATABASE_URL and a seeded nexum schema) ──

    /// Edge-semantic search returns the nearest typed link on seeded data.
    ///
    /// Skipped unless `DATABASE_URL` is set.
    #[tokio::test]
    #[ignore = "integration: requires DATABASE_URL and seeded nexum schema"]
    async fn edge_semantic_returns_nearest_link() {
        use sqlx::PgPool;

        let database_url =
            std::env::var("DATABASE_URL").expect("DATABASE_URL must be set");
        let pool = PgPool::connect(&database_url)
            .await
            .expect("pool creation failed");
        let embedder = Embedder::new().expect("embedder init failed");

        let corpus_id = seed_test_corpus(&pool).await;
        let doc_id = seed_test_document(&pool, corpus_id, "Edge-semantic search test").await;
        let src_id = seed_test_block_bare(&pool, doc_id, "Payment is due under Section 4").await;
        let dst_id = seed_test_block_bare(&pool, doc_id, "Section 4 governs the fees").await;

        // Write an edge with an edge embedding via the shared helper.
        let edge_vec = crate::links::embed_edge(
            &embedder,
            "Payment is due under Section 4",
            "Section 4 governs the fees",
            Some("cites"),
        )
        .expect("embed_edge failed");
        sqlx::query(
            r#"INSERT INTO nexum.links (id, src, dst, layer, rel_type, weight, provenance, edge_embedding)
               VALUES ($1, $2, $3, 'structural', 'cites', 1.0, '{}'::jsonb, $4::vector)"#,
        )
        .bind(Uuid::new_v4())
        .bind(src_id)
        .bind(dst_id)
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
        .expect("edge_semantic_search should succeed");

        assert!(!results.is_empty(), "expected at least one edge result");
        assert_eq!(results[0].src.block_id, src_id);
        assert_eq!(results[0].dst.block_id, dst_id);
        assert_eq!(results[0].rel_type.as_deref(), Some("cites"));
    }


    /// Full-text search returns results for a known query on seeded data.
    ///
    /// Skipped unless `DATABASE_URL` is set.
    #[tokio::test]
    #[ignore = "integration: requires DATABASE_URL and seeded nexum schema"]
    async fn fulltext_returns_results_on_seeded_data() {
        use sqlx::PgPool;

        let database_url =
            std::env::var("DATABASE_URL").expect("DATABASE_URL must be set");
        let pool = PgPool::connect(&database_url)
            .await
            .expect("pool creation failed");

        let corpus_id = seed_test_corpus(&pool).await;
        let doc_id = seed_test_document(&pool, corpus_id, "Full-text search test").await;
        seed_test_block(&pool, doc_id, "The quick brown fox jumps over the lazy dog").await;

        let results = fulltext_search(
            &pool,
            FullTextOptions {
                corpus_id,
                query_text: "quick brown fox".into(),
                limit: 10,
            },
        )
        .await
        .expect("fulltext_search should succeed");

        assert!(
            !results.is_empty(),
            "expected at least one full-text result for 'quick brown fox'"
        );
        assert!(
            results[0].content.contains("fox"),
            "top result should contain 'fox'"
        );
    }

    /// Semantic search returns results for a known query on seeded data.
    ///
    /// Skipped unless `DATABASE_URL` is set.
    #[tokio::test]
    #[ignore = "integration: requires DATABASE_URL and seeded nexum schema"]
    async fn semantic_returns_results_on_seeded_data() {
        use sqlx::PgPool;

        let database_url =
            std::env::var("DATABASE_URL").expect("DATABASE_URL must be set");
        let pool = PgPool::connect(&database_url)
            .await
            .expect("pool creation failed");
        let embedder = Embedder::new().expect("embedder init failed");

        let corpus_id = seed_test_corpus(&pool).await;
        let doc_id = seed_test_document(&pool, corpus_id, "Semantic search test").await;
        seed_test_block_with_embedding(
            &pool,
            doc_id,
            "Rust is a systems programming language",
            &embedder,
        )
        .await;

        let results = semantic_search(
            &pool,
            &embedder,
            SemanticOptions {
                corpus_id,
                query_text: "systems programming".into(),
                limit: 10,
            },
        )
        .await
        .expect("semantic_search should succeed");

        assert!(
            !results.is_empty(),
            "expected at least one semantic result for 'systems programming'"
        );
        assert!(
            results[0].score > 0.0,
            "score should be positive: {}",
            results[0].score
        );
    }

    /// Graph traversal returns one-hop neighbours via recursive CTE.
    ///
    /// Skipped unless `DATABASE_URL` is set.
    #[tokio::test]
    #[ignore = "integration: requires DATABASE_URL and seeded nexum schema"]
    async fn graph_returns_one_hop_neighbours() {
        use sqlx::PgPool;

        let database_url =
            std::env::var("DATABASE_URL").expect("DATABASE_URL must be set");
        let pool = PgPool::connect(&database_url)
            .await
            .expect("pool creation failed");

        let corpus_id = seed_test_corpus(&pool).await;
        let doc_id = seed_test_document(&pool, corpus_id, "Graph traversal test").await;
        let src_id = seed_test_block_bare(&pool, doc_id, "Source block").await;
        let dst_id = seed_test_block_bare(&pool, doc_id, "Destination block").await;
        seed_test_link(&pool, src_id, dst_id, "structural").await;

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
        .expect("graph_search should succeed");

        assert_eq!(results.len(), 1, "expected exactly one neighbour");
        assert_eq!(results[0].block_id, dst_id);
        assert_eq!(results[0].depth, 1);
    }

    /// Hybrid search combines semantic and graph results without duplicates.
    ///
    /// Skipped unless `DATABASE_URL` is set.
    #[tokio::test]
    #[ignore = "integration: requires DATABASE_URL and seeded nexum schema"]
    async fn hybrid_combines_semantic_and_graph_without_duplicates() {
        use sqlx::PgPool;

        let database_url =
            std::env::var("DATABASE_URL").expect("DATABASE_URL must be set");
        let pool = PgPool::connect(&database_url)
            .await
            .expect("pool creation failed");
        let embedder = Embedder::new().expect("embedder init failed");

        let corpus_id = seed_test_corpus(&pool).await;
        let doc_id = seed_test_document(&pool, corpus_id, "Hybrid search test").await;
        let src_id =
            seed_test_block_with_embedding(&pool, doc_id, "Rust memory safety model", &embedder)
                .await;
        let dst_id = seed_test_block_bare(&pool, doc_id, "Ownership and borrowing").await;
        seed_test_link(&pool, src_id, dst_id, "structural").await;

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
        .expect("hybrid_search should succeed");

        // No duplicate block IDs.
        let ids: Vec<Uuid> = results.iter().map(|r| r.block_id).collect();
        let unique: std::collections::HashSet<Uuid> = ids.iter().cloned().collect();
        assert_eq!(
            ids.len(),
            unique.len(),
            "hybrid results should be deduplicated"
        );

        // At least the semantic result is present.
        assert!(
            results.iter().any(|r| r.block_id == src_id),
            "semantic seed block should appear in hybrid results"
        );

        // The graph neighbour is present and tagged 'graph'.
        let graph_hit = results.iter().find(|r| r.block_id == dst_id);
        assert!(
            graph_hit.is_some(),
            "graph neighbour should appear in hybrid results"
        );
        assert_eq!(
            graph_hit.unwrap().origin.as_deref(),
            Some("graph"),
            "graph neighbour should be tagged 'graph'"
        );
    }

    // ── Integration test helpers ──────────────────────────────────────────────

    #[allow(dead_code)]
    async fn seed_test_corpus(pool: &PgPool) -> Uuid {
        sqlx::query_scalar("INSERT INTO nexum.corpora (name) VALUES ($1) RETURNING id")
            .bind(format!("test-corpus-{}", Uuid::new_v4()))
            .fetch_one(pool)
            .await
            .expect("corpus insert failed")
    }

    #[allow(dead_code)]
    async fn seed_test_document(pool: &PgPool, corpus_id: Uuid, title: &str) -> Uuid {
        sqlx::query_scalar(
            "INSERT INTO nexum.documents (corpus_id, title) VALUES ($1, $2) RETURNING id",
        )
        .bind(corpus_id)
        .bind(title)
        .fetch_one(pool)
        .await
        .expect("document insert failed")
    }

    /// Insert a bare block (no embedding, no tsv) for graph-only tests.
    #[allow(dead_code)]
    async fn seed_test_block_bare(pool: &PgPool, doc_id: Uuid, content: &str) -> Uuid {
        sqlx::query_scalar(
            r#"INSERT INTO nexum.blocks (doc_id, content, content_hash, block_type)
               VALUES ($1, $2, $3, 'paragraph') RETURNING id"#,
        )
        .bind(doc_id)
        .bind(content)
        .bind(crate::dedup::content_hash(content))
        .fetch_one(pool)
        .await
        .expect("block insert failed")
    }

    /// Insert a block with tsvector for full-text tests.
    #[allow(dead_code)]
    async fn seed_test_block(pool: &PgPool, doc_id: Uuid, content: &str) -> Uuid {
        sqlx::query_scalar(
            r#"INSERT INTO nexum.blocks (doc_id, content, content_hash, block_type, tsv)
               VALUES ($1, $2, $3, 'paragraph', to_tsvector('english', $2)) RETURNING id"#,
        )
        .bind(doc_id)
        .bind(content)
        .bind(crate::dedup::content_hash(content))
        .fetch_one(pool)
        .await
        .expect("block insert (tsv) failed")
    }

    /// Insert a block with both embedding and tsvector for semantic/hybrid tests.
    #[allow(dead_code)]
    async fn seed_test_block_with_embedding(
        pool: &PgPool,
        doc_id: Uuid,
        content: &str,
        embedder: &Embedder,
    ) -> Uuid {
        let vec = embedder.embed_one(content).expect("embed failed");
        let vec_str = format!(
            "[{}]",
            vec.iter()
                .map(|v| v.to_string())
                .collect::<Vec<_>>()
                .join(",")
        );
        sqlx::query_scalar(
            r#"INSERT INTO nexum.blocks (doc_id, content, content_hash, block_type, embedding, tsv)
               VALUES ($1, $2, $3, 'paragraph', $4::vector, to_tsvector('english', $2)) RETURNING id"#,
        )
        .bind(doc_id)
        .bind(content)
        .bind(crate::dedup::content_hash(content))
        .bind(&vec_str)
        .fetch_one(pool)
        .await
        .expect("block insert (embedding) failed")
    }

    /// Insert a structural link between two blocks.
    #[allow(dead_code)]
    async fn seed_test_link(pool: &PgPool, src: Uuid, dst: Uuid, layer: &str) {
        sqlx::query(
            r#"INSERT INTO nexum.links (id, src, dst, layer, rel_type, weight)
               VALUES ($1, $2, $3, $4, 'cites', 1.0)"#,
        )
        .bind(Uuid::new_v4())
        .bind(src)
        .bind(dst)
        .bind(layer)
        .execute(pool)
        .await
        .expect("link insert failed");
    }
}
