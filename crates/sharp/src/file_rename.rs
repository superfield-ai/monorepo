//! File-level rename detection via Jaccard line-set similarity.
//!
//! Ports `detectFileRenames` from the TypeScript merge engine
//! (`sharp/apps/client/src/merge/index.ts`).
//!
//! A file is considered "renamed" between two trees when:
//!   - it exists in `base` but not in `derived` (deleted), AND
//!   - some file exists in `derived` but not in `base` (added) whose content
//!     is sufficiently similar to the deleted file's content.
//!
//! Greedy pairing: for each deleted file, pick the most-similar added file
//! above [`SIMILARITY_THRESHOLD`] that has not already been paired.
//! Similarity is the Jaccard index over the trimmed, non-empty line sets of
//! each file (the v1 heuristic; AST-level similarity is a later refinement).
//!
//! §architecture.md — Sharp subsystem (Tier-1 file-rename detection)

use std::collections::{BTreeMap, HashSet};

/// Similarity threshold for declaring a file rename.
///
/// Tuned against the corpus (matching the TS engine): `0.3` catches the
/// canonical "move + small refactor" pattern (function moved to a new file,
/// body edited, comment added) without false-pairing unrelated files.
/// Anything below ~0.2 is too noisy; above ~0.5 misses moves with even
/// modest edits.
pub const SIMILARITY_THRESHOLD: f64 = 0.3;

/// Compute the Jaccard index of two string sets.
///
/// Two empty sets are defined to be identical (`1.0`), matching the TS
/// implementation.
pub fn jaccard(a: &HashSet<String>, b: &HashSet<String>) -> f64 {
    if a.is_empty() && b.is_empty() {
        return 1.0;
    }
    let mut inter = 0usize;
    for x in a {
        if b.contains(x) {
            inter += 1;
        }
    }
    let union = a.len() + b.len() - inter;
    if union == 0 {
        0.0
    } else {
        inter as f64 / union as f64
    }
}

/// Build the set of trimmed, non-empty lines of `content`.
pub fn line_set(content: &str) -> HashSet<String> {
    content
        .split('\n')
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .map(|l| l.to_string())
        .collect()
}

/// Detect file-level renames in `derived` relative to `base`.
///
/// Both arguments map `path -> content`. Returns a map `old_path -> new_path`
/// for each detected rename. Uses a [`BTreeMap`] for deterministic iteration
/// order so pairing is reproducible across runs.
pub fn detect_file_renames(
    base: &BTreeMap<String, String>,
    derived: &BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();

    let deleted: Vec<(String, HashSet<String>)> = base
        .iter()
        .filter(|(p, _)| !derived.contains_key(*p))
        .map(|(p, c)| (p.clone(), line_set(c)))
        .collect();
    let added: Vec<(String, HashSet<String>)> = derived
        .iter()
        .filter(|(p, _)| !base.contains_key(*p))
        .map(|(p, c)| (p.clone(), line_set(c)))
        .collect();

    let mut consumed: HashSet<String> = HashSet::new();
    for (d_path, d_lines) in &deleted {
        let mut best: Option<(String, f64)> = None;
        for (a_path, a_lines) in &added {
            if consumed.contains(a_path) {
                continue;
            }
            let sim = jaccard(d_lines, a_lines);
            match &best {
                Some((_, best_sim)) if sim <= *best_sim => {}
                _ => best = Some((a_path.clone(), sim)),
            }
        }
        if let Some((a_path, sim)) = best {
            if sim >= SIMILARITY_THRESHOLD {
                out.insert(d_path.clone(), a_path.clone());
                consumed.insert(a_path);
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(items: &[&str]) -> HashSet<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn jaccard_empty_sets_are_identical() {
        assert_eq!(jaccard(&set(&[]), &set(&[])), 1.0);
    }

    #[test]
    fn jaccard_disjoint_is_zero() {
        assert_eq!(jaccard(&set(&["a"]), &set(&["b"])), 0.0);
    }

    #[test]
    fn jaccard_half_overlap() {
        // {a,b} vs {b,c}: inter=1, union=3 -> 1/3
        let s = jaccard(&set(&["a", "b"]), &set(&["b", "c"]));
        assert!((s - 1.0 / 3.0).abs() < 1e-9);
    }

    #[test]
    fn line_set_trims_and_drops_blanks() {
        let s = line_set("  foo  \n\n  bar\n");
        assert_eq!(s, set(&["foo", "bar"]));
    }

    #[test]
    fn detects_move_with_small_edit() {
        let mut base = BTreeMap::new();
        base.insert(
            "old.rs".to_string(),
            "fn a() {}\nfn b() {}\nfn c() {}\nfn d() {}".to_string(),
        );
        let mut derived = BTreeMap::new();
        // Same body plus a comment: well above 0.3.
        derived.insert(
            "new.rs".to_string(),
            "// moved\nfn a() {}\nfn b() {}\nfn c() {}\nfn d() {}".to_string(),
        );
        let renames = detect_file_renames(&base, &derived);
        assert_eq!(renames.get("old.rs"), Some(&"new.rs".to_string()));
    }

    #[test]
    fn does_not_pair_unrelated_files() {
        let mut base = BTreeMap::new();
        base.insert("old.rs".to_string(), "fn a() {}\nfn b() {}".to_string());
        let mut derived = BTreeMap::new();
        derived.insert(
            "new.rs".to_string(),
            "struct Z;\nimpl Z {}\nfn totally_different() {}".to_string(),
        );
        let renames = detect_file_renames(&base, &derived);
        assert!(renames.is_empty());
    }

    #[test]
    fn greedy_pairing_consumes_added_files() {
        let mut base = BTreeMap::new();
        base.insert("a_old.rs".to_string(), "x\ny\nz\nw".to_string());
        base.insert("b_old.rs".to_string(), "x\ny\nz\nw".to_string());
        let mut derived = BTreeMap::new();
        derived.insert("a_new.rs".to_string(), "x\ny\nz\nw".to_string());
        let renames = detect_file_renames(&base, &derived);
        // Only one added file: exactly one rename, the other deleted stays.
        assert_eq!(renames.len(), 1);
    }
}
