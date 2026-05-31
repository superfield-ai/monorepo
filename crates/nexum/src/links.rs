//! Structural link extraction from block content.
//!
//! Mirrors `extractCitationRefs` in `src/linker/structural.ts` from the
//! Nexum Node service — same citation patterns, same output format.
//!
//! A *structural link* is a cross-reference found by scanning block text with
//! regular expressions.  Links are stored in the `links` table with
//! `layer = 'structural'` and `rel_type = 'cites'`.

use once_cell::sync::Lazy;
use regex::Regex;

// ── Citation patterns ─────────────────────────────────────────────────────────

/// A single citation pattern: a compiled [`Regex`] and the reference type it
/// captures (e.g. `"section"`, `"exhibit"`).
struct Pattern {
    regex: &'static Lazy<Regex>,
    kind: &'static str,
}

static RE_SECTION_SYMBOL: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"§\s*(\d+[\.\d]*)").unwrap());
static RE_PARAGRAPH_SYMBOL: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"¶\s*(\d+)").unwrap());
static RE_SECTION_WORD: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"[Ss]ection\s+(\d+[\.\d]*)").unwrap());
static RE_EXHIBIT: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"[Ee]xhibit\s+([A-Z])").unwrap());
static RE_SCHEDULE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"[Ss]chedule\s+(\d+)").unwrap());

static PATTERNS: &[Pattern] = &[
    Pattern { regex: &RE_SECTION_SYMBOL,  kind: "section"   },
    Pattern { regex: &RE_PARAGRAPH_SYMBOL, kind: "paragraph" },
    Pattern { regex: &RE_SECTION_WORD,     kind: "section"   },
    Pattern { regex: &RE_EXHIBIT,          kind: "exhibit"   },
    Pattern { regex: &RE_SCHEDULE,         kind: "schedule"  },
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
}
