//! Structural link extraction from block content.
//!
//! Mirrors `extractCitationRefs` in `src/linker/structural.ts` from the
//! Nexum Node service — same citation patterns, same output format.
//!
//! A *structural link* is a cross-reference found by scanning block text with
//! regular expressions.  Links are stored in the `links` table with
//! `layer = 'structural'` and `rel_type = 'cites'`.

use crate::embed::{EmbedError, Embedder};
use once_cell::sync::Lazy;
use regex::Regex;

// ── Citation patterns ─────────────────────────────────────────────────────────

/// A single citation pattern: a compiled [`Regex`] and the reference type it
/// captures (e.g. `"section"`, `"exhibit"`).
struct Pattern {
    regex: &'static Lazy<Regex>,
    kind: &'static str,
}

static RE_SECTION_SYMBOL: Lazy<Regex> = Lazy::new(|| Regex::new(r"§\s*(\d+[\.\d]*)").unwrap());
static RE_PARAGRAPH_SYMBOL: Lazy<Regex> = Lazy::new(|| Regex::new(r"¶\s*(\d+)").unwrap());
static RE_SECTION_WORD: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"[Ss]ection\s+(\d+[\.\d]*)").unwrap());
static RE_EXHIBIT: Lazy<Regex> = Lazy::new(|| Regex::new(r"[Ee]xhibit\s+([A-Z])").unwrap());
static RE_SCHEDULE: Lazy<Regex> = Lazy::new(|| Regex::new(r"[Ss]chedule\s+(\d+)").unwrap());

static PATTERNS: &[Pattern] = &[
    Pattern {
        regex: &RE_SECTION_SYMBOL,
        kind: "section",
    },
    Pattern {
        regex: &RE_PARAGRAPH_SYMBOL,
        kind: "paragraph",
    },
    Pattern {
        regex: &RE_SECTION_WORD,
        kind: "section",
    },
    Pattern {
        regex: &RE_EXHIBIT,
        kind: "exhibit",
    },
    Pattern {
        regex: &RE_SCHEDULE,
        kind: "schedule",
    },
];

// ── Public API ────────────────────────────────────────────────────────────────

/// Extract all structural citation references from `content`.
///
/// Returns a deduplicated list of `"<kind>:<value>"` strings, e.g.
/// `["section:3.1", "exhibit:A"]`.  An empty list means no citations were
/// found.
///
/// Mirrors `extractCitationRefs` in `src/linker/structural.ts`.
pub fn extract_citation_refs(content: &str) -> Vec<String> {
    let mut refs: Vec<String> = Vec::new();

    for p in PATTERNS {
        for cap in p.regex.captures_iter(content) {
            if let Some(m) = cap.get(1) {
                refs.push(format!("{}:{}", p.kind, m.as_str()));
            }
        }
    }

    // Deduplicate (preserve first occurrence order).
    let mut seen = std::collections::HashSet::new();
    refs.retain(|r| seen.insert(r.clone()));
    refs
}

/// A structural link to be written to the `links` table.
#[derive(Debug, Clone)]
pub struct StructuralLink {
    /// UUID of the source block (`src`).
    pub src_block_id: String,
    /// UUID of the target block (`dst`).
    pub dst_block_id: String,
    /// Always `"structural"` for links produced by this module.
    pub layer: String,
    /// Always `"cites"` for structural citation links.
    pub rel_type: String,
    /// Always `1.0` — regex hits are treated as confirmed references.
    pub weight: f64,
}

impl StructuralLink {
    /// Construct a new structural `cites` link.
    pub fn new(src: impl Into<String>, dst: impl Into<String>) -> Self {
        Self {
            src_block_id: src.into(),
            dst_block_id: dst.into(),
            layer: "structural".into(),
            rel_type: "cites".into(),
            weight: 1.0,
        }
    }
}

// ── Edge embedding ──────────────────────────────────────────────────────────────
//
// Mirrors `src/linker/edge-embed.ts` from the Nexum Node service.  An *edge
// embedding* is a 384-dim vector produced by embedding a templated string of
// the form `"<rel_type>: <src_snippet> -> <dst_snippet>"` with the same
// all-MiniLM-L6-v2 model used for blocks, so edge vectors live in the same
// space and can be retrieved with the same pgvector cosine operator.
//
// These helpers live here once; the edge-embedding query path (#22) reuses
// them.

/// Max characters of each endpoint's content folded into the edge text.
///
/// Mirrors `SNIPPET_CHARS` in `edge-embed.ts`.  The embedder truncates at the
/// token level anyway; capping the character count earlier keeps the latency
/// floor predictable across edge-count scale.
const SNIPPET_CHARS: usize = 240;

/// Truncate `s` to at most [`SNIPPET_CHARS`] characters (UTF-8 safe — never
/// splits a multi-byte character), collapse all internal whitespace runs to a
/// single space, and trim the ends.
///
/// Mirrors `s.slice(0, SNIPPET_CHARS).replace(/\s+/g, ' ').trim()`.  Note JS
/// `String.slice` counts UTF-16 code units; here we count Unicode scalar
/// values via `char_indices`, which is the closest UTF-8-safe analogue and
/// avoids panicking on a byte boundary inside a multi-byte character.
fn snippet(s: &str) -> String {
    let truncated: &str = match s.char_indices().nth(SNIPPET_CHARS) {
        Some((byte_idx, _)) => &s[..byte_idx],
        None => s,
    };
    truncated.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Build the templated edge text `"<rel>: <src_snippet> -> <dst_snippet>"`.
///
/// `rel_type` of `None` falls back to `"related"`.  Mirrors `buildEdgeText`
/// in `edge-embed.ts`.
pub fn build_edge_text(src_content: &str, dst_content: &str, rel_type: Option<&str>) -> String {
    let rel = rel_type.unwrap_or("related");
    let src = snippet(src_content);
    let dst = snippet(dst_content);
    format!("{rel}: {src} -> {dst}")
}

/// Render a 384-dim vector as a pgvector literal `[v1,v2,...]` for binding as
/// `$N::vector`.  Mirrors `vectorLiteral` in `edge-embed.ts`.
pub fn vector_literal(vec: &[f32]) -> String {
    format!(
        "[{}]",
        vec.iter()
            .map(|v| v.to_string())
            .collect::<Vec<_>>()
            .join(",")
    )
}

/// Embed one edge.  Builds the edge text from the two endpoint contents and
/// `rel_type`, embeds it with the shared model, and returns the pgvector
/// literal string ready to bind as `$N::vector`.
///
/// Mirrors `embedEdge` in `edge-embed.ts`.  Unlike the TypeScript version
/// (which returns `null` on an empty embedder result), the Rust embedder
/// surfaces that case as [`EmbedError`].
pub fn embed_edge(
    embedder: &Embedder,
    src_content: &str,
    dst_content: &str,
    rel_type: Option<&str>,
) -> Result<String, EmbedError> {
    let text = build_edge_text(src_content, dst_content, rel_type);
    let vec = embedder.embed_one(&text)?;
    Ok(vector_literal(&vec))
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_refs_for_plain_text() {
        assert!(extract_citation_refs("Hello world, no citations here.").is_empty());
    }

    #[test]
    fn extracts_section_symbol() {
        let refs = extract_citation_refs("See § 3.1 for details.");
        assert!(refs.contains(&"section:3.1".to_string()), "{refs:?}");
    }

    #[test]
    fn extracts_section_word() {
        let refs = extract_citation_refs("Refer to Section 12 of this agreement.");
        assert!(refs.contains(&"section:12".to_string()), "{refs:?}");
    }

    #[test]
    fn extracts_exhibit() {
        let refs = extract_citation_refs("Attached as Exhibit A.");
        assert!(refs.contains(&"exhibit:A".to_string()), "{refs:?}");
    }

    #[test]
    fn extracts_schedule() {
        let refs = extract_citation_refs("Schedule 1 applies here.");
        assert!(refs.contains(&"schedule:1".to_string()), "{refs:?}");
    }

    #[test]
    fn deduplicates_refs() {
        let refs = extract_citation_refs("§ 1 and § 1 again.");
        let count = refs.iter().filter(|r| *r == "section:1").count();
        assert_eq!(count, 1, "duplicate refs should be collapsed");
    }

    #[test]
    fn multiple_refs_in_one_block() {
        let refs = extract_citation_refs("See § 2.3 and Exhibit B and Schedule 3.");
        assert!(refs.contains(&"section:2.3".to_string()));
        assert!(refs.contains(&"exhibit:B".to_string()));
        assert!(refs.contains(&"schedule:3".to_string()));
    }

    #[test]
    fn build_edge_text_defaults_rel_to_related() {
        assert_eq!(build_edge_text("a", "b", None), "related: a -> b");
    }

    #[test]
    fn build_edge_text_uses_rel_and_collapses_whitespace() {
        let text = build_edge_text("the  quick\n brown", "lazy\tdog ", Some("cites"));
        assert_eq!(text, "cites: the quick brown -> lazy dog");
    }

    #[test]
    fn snippet_truncates_at_char_boundary() {
        // 250 multi-byte chars; truncation must not panic mid-character and
        // must keep at most SNIPPET_CHARS scalar values.
        let long: String = "é".repeat(250);
        let out = snippet(&long);
        assert_eq!(out.chars().count(), SNIPPET_CHARS);
    }

    #[test]
    fn vector_literal_formats_pgvector() {
        assert_eq!(vector_literal(&[1.0, 2.5, -3.0]), "[1,2.5,-3]");
    }
}
