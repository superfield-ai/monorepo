//! AI linker — keyword-heuristic relation classification.
//!
//! Mirrors `src/linker/ai.ts` from the Nexum Node service (the pre-Phase-3
//! inline heuristic — the `InferenceClient` abstraction and AGE graph mirroring
//! are deliberately out of scope; see `docs/rust-reorg-decisions.md` §7).
//!
//! For each block in a version, the linker finds semantically similar blocks in
//! the same corpus (pgvector cosine ANN self-join, `> 0.70`, top 20), classifies
//! the relation between the two contents with a fixed keyword heuristic
//! ([`classify_pair`]), and writes the resulting edge to `nexum.links` with
//! `layer = 'ai'` (edge embedding populated via the shared
//! [`crate::links::embed_edge`] helper).

use crate::embed::Embedder;
use crate::links::embed_edge;
use once_cell::sync::Lazy;
use sqlx::PgPool;
use thiserror::Error;
use uuid::Uuid;

// ── Error ─────────────────────────────────────────────────────────────────────

/// Errors that can occur while processing AI links.
#[derive(Debug, Error)]
pub enum AiLinkError {
    /// A database error.
    #[error("database error: {0}")]
    Database(#[from] sqlx::Error),

    /// The embedding model could not be loaded or failed during inference.
    #[error("embedding error: {0}")]
    Embed(#[from] crate::embed::EmbedError),
}

// ── Signals ───────────────────────────────────────────────────────────────────

/// Keyword signals per relation type, in priority order.
///
/// Mirrors `SIGNALS` in `ai.ts` exactly — same relation types, same keyword
/// lists, same casing, and same trailing spaces (e.g. `"not "`, `"but "`).
/// The first relation type whose keyword list matches wins (see
/// [`classify_pair`]); the ordering of this slice therefore encodes priority.
static SIGNALS: Lazy<Vec<(&'static str, Vec<&'static str>)>> = Lazy::new(|| {
    vec![
        (
            "contradicts",
            vec![
                "not ", "however", "contrary", "but ", "instead", "unlike", "disagrees",
                "conflicts",
            ],
        ),
        (
            "supports",
            vec![
                "similarly",
                "also ",
                "furthermore",
                "consistent",
                "confirms",
                "in accordance",
                "agrees",
            ],
        ),
        (
            "elaborates",
            vec![
                "specifically",
                "for example",
                "in particular",
                "namely",
                "that is",
                "i.e.",
                "e.g.",
            ],
        ),
        (
            "overrides",
            vec![
                "supersedes",
                "replaces",
                "amends",
                "notwithstanding",
                "prevails over",
                "controls over",
            ],
        ),
        (
            "is-exception-to",
            vec![
                "except",
                "unless",
                "provided that",
                "subject to",
                "other than",
                "excluding",
            ],
        ),
    ]
});

// ── Classification ──────────────────────────────────────────────────────────────

/// Classify the relation from a candidate block (`content_b`) given the cosine
/// similarity `sim` to the source block.
///
/// Mirrors `classifyPair` in `ai.ts`:
///
/// - returns `None` if `sim < 0.70`;
/// - otherwise the first relation type in [`SIGNALS`] whose keyword list has a
///   case-insensitive substring match against `content_b` wins;
/// - otherwise `Some("supports")` if `sim > 0.85`, else `None`.
///
/// Only `content_b` is inspected (the TS `contentA` argument is unused by the
/// heuristic), so it is omitted here.
pub fn classify_pair(content_b: &str, sim: f64) -> Option<&'static str> {
    if sim < 0.70 {
        return None;
    }
    let b = content_b.to_lowercase();
    for (rel_type, keywords) in SIGNALS.iter() {
        if keywords.iter().any(|kw| b.contains(kw)) {
            return Some(rel_type);
        }
    }
    if sim > 0.85 {
        Some("supports")
    } else {
        None
    }
}

// ── Processing ──────────────────────────────────────────────────────────────────

/// Block row loaded for a version: id + content.
struct BlockRow {
    id: Uuid,
    content: String,
}

/// Candidate similar block: id, content, cosine similarity to the source.
struct Candidate {
    id: Uuid,
    content: String,
    sim: f64,
}

/// Process AI links for one document version.
///
/// Mirrors `processAiLinks` in `ai.ts`:
///
/// 1. Load all embedded blocks for `version_id`.
/// 2. Resolve the corpus via the first block's document.
/// 3. For each block, find up to 20 similar blocks in the same corpus
///    (pgvector cosine ANN self-join, similarity `> 0.70`).
/// 4. Classify each pair with [`classify_pair`]; skip `None`.
/// 5. Embed the edge with the shared [`embed_edge`] helper and `INSERT INTO
///    nexum.links` with `layer = 'ai'` (`ON CONFLICT DO NOTHING`).
///
/// AGE graph mirroring is intentionally omitted (out of scope).
pub async fn process_ai_links(
    pool: &PgPool,
    embedder: &Embedder,
    version_id: Uuid,
) -> Result<(), AiLinkError> {
    // 1. Load all embedded blocks for this version (with their doc_id so we can
    //    resolve the corpus).
    let blocks: Vec<(Uuid, String, Uuid)> = sqlx::query_as(
        r#"
        SELECT b.id, b.content, b.doc_id
        FROM nexum.blocks b
        JOIN nexum.version_blocks vb ON vb.block_id = b.id
        WHERE vb.version_id = $1 AND b.embedding IS NOT NULL
        "#,
    )
    .bind(version_id)
    .fetch_all(pool)
    .await?;

    if blocks.is_empty() {
        return Ok(());
    }

    // 2. Resolve the corpus via the first block's document.
    let first_doc_id = blocks[0].2;
    let corpus_id: Option<Uuid> =
        sqlx::query_scalar("SELECT corpus_id FROM nexum.documents WHERE id = $1")
            .bind(first_doc_id)
            .fetch_optional(pool)
            .await?;
    let Some(corpus_id) = corpus_id else {
        return Ok(());
    };

    let blocks: Vec<BlockRow> = blocks
        .into_iter()
        .map(|(id, content, _)| BlockRow { id, content })
        .collect();

    for block in &blocks {
        // 3. Find similar blocks in the same corpus using pgvector cosine ANN.
        let similar: Vec<(Uuid, String, f64)> = sqlx::query_as(
            r#"
            SELECT b2.id, b2.content,
                   1 - (b1.embedding <=> b2.embedding) AS sim
            FROM nexum.blocks b1, nexum.blocks b2
            JOIN nexum.documents d ON d.id = b2.doc_id
            WHERE b1.id = $1
              AND d.corpus_id = $2
              AND b2.id != b1.id
              AND b2.embedding IS NOT NULL
              AND 1 - (b1.embedding <=> b2.embedding) > 0.70
            ORDER BY sim DESC
            LIMIT 20
            "#,
        )
        .bind(block.id)
        .bind(corpus_id)
        .fetch_all(pool)
        .await?;

        for cand in similar {
            let candidate = Candidate {
                id: cand.0,
                content: cand.1,
                sim: cand.2,
            };

            // 4. Classify.
            let Some(rel_type) = classify_pair(&candidate.content, candidate.sim) else {
                continue;
            };

            // 5. Embed the edge with the shared helper and write the link.
            let edge_vec = embed_edge(embedder, &block.content, &candidate.content, Some(rel_type))?;

            let provenance = format!(
                r#"{{"model":"keyword-heuristics-v1","confidence":{}}}"#,
                candidate.sim
            );

            sqlx::query(
                r#"
                INSERT INTO nexum.links (id, src, dst, layer, rel_type, weight, confirmed, provenance, edge_embedding)
                VALUES ($1, $2, $3, 'ai', $4, $5, NULL, $6::jsonb, $7::vector)
                ON CONFLICT DO NOTHING
                "#,
            )
            .bind(Uuid::new_v4())
            .bind(block.id)
            .bind(candidate.id)
            .bind(rel_type)
            .bind(candidate.sim)
            .bind(&provenance)
            .bind(&edge_vec)
            .execute(pool)
            .await?;
        }
    }

    Ok(())
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn below_threshold_returns_none() {
        assert_eq!(classify_pair("similarly, this also confirms it", 0.69), None);
    }

    #[test]
    fn first_keyword_match_wins() {
        // "however" is a contradicts signal; even though "similarly" (supports)
        // also appears, contradicts is earlier in SIGNALS and wins.
        assert_eq!(
            classify_pair("however, this is similarly true", 0.9),
            Some("contradicts")
        );
    }

    #[test]
    fn keyword_match_is_case_insensitive() {
        assert_eq!(
            classify_pair("HOWEVER, the rule differs", 0.75),
            Some("contradicts")
        );
    }

    #[test]
    fn supports_keyword() {
        assert_eq!(
            classify_pair("furthermore, the claim holds", 0.72),
            Some("supports")
        );
    }

    #[test]
    fn elaborates_keyword() {
        assert_eq!(
            classify_pair("for example, consider this", 0.8),
            Some("elaborates")
        );
    }

    #[test]
    fn overrides_keyword() {
        assert_eq!(
            classify_pair("this supersedes the prior clause", 0.8),
            Some("overrides")
        );
    }

    #[test]
    fn is_exception_to_keyword() {
        assert_eq!(
            classify_pair("valid unless revoked", 0.8),
            Some("is-exception-to")
        );
    }

    #[test]
    fn high_sim_no_keyword_falls_back_to_supports() {
        assert_eq!(classify_pair("plain unrelated text", 0.86), Some("supports"));
    }

    #[test]
    fn mid_sim_no_keyword_returns_none() {
        assert_eq!(classify_pair("plain unrelated text", 0.80), None);
    }

    #[test]
    fn boundary_sim_exactly_threshold_is_kept() {
        // sim == 0.70 is not < 0.70, so it passes the gate; no keyword and not
        // > 0.85, so None.
        assert_eq!(classify_pair("plain unrelated text", 0.70), None);
    }

    #[test]
    fn boundary_sim_just_below_threshold_is_rejected() {
        assert_eq!(classify_pair("furthermore it holds", 0.6999), None);
    }

    #[test]
    fn trailing_space_keyword_does_not_match_substring() {
        // "not " (with trailing space) is a contradicts signal; "notion" must
        // NOT match it because of the trailing space, mirroring the TS list.
        assert_eq!(classify_pair("a notion of fairness", 0.80), None);
    }

    #[test]
    fn trailing_space_keyword_matches_word() {
        assert_eq!(
            classify_pair("this is not the case", 0.80),
            Some("contradicts")
        );
    }

    /// Integration test: requires a real Postgres instance.
    #[tokio::test]
    #[ignore = "integration: requires DATABASE_URL"]
    async fn process_ai_links_smoke() {
        let database_url = std::env::var("DATABASE_URL").expect("DATABASE_URL must be set");
        let pool = PgPool::connect(&database_url)
            .await
            .expect("pool creation failed");
        let embedder = Embedder::new().expect("embedder init failed");

        // A non-existent version should be a no-op (no blocks).
        process_ai_links(&pool, &embedder, Uuid::new_v4())
            .await
            .expect("no-op on empty version");
    }
}
