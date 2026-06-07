//! Tier-2 oracle scoring scaffold.
//!
//! Ports `scoreAgainstOracles` and the `classifyPath` three-way
//! classification it relies on from the TypeScript merge engine
//! (`sharp/apps/client/src/merge/index.ts`).
//!
//! Per whitepaper §6.4 and engineering-plan §7.3: when Tier 1 produces
//! multiple candidate merged trees, score each against a set of oracle
//! branches (other in-development branches that serve as ground truth for
//! downstream compatibility). For each oracle branch we simulate the
//! three-way classification of (base, candidate, oracle) and count paths that
//! would be a hard conflict — `both_different` (both candidate and oracle
//! changed a file that existed in base) or `a_added_b_added_diff` (both added
//! the same path with different content). A lower score means the candidate is
//! more compatible with the downstream oracle branches.
//!
//! This is intentionally lightweight — the full Tier 1 pipeline is not re-run;
//! only the classification is checked to identify hard conflicts.
//!
//! §architecture.md — Sharp subsystem (Tier-2 oracle scoring)

use std::collections::{BTreeMap, BTreeSet};

/// A candidate or oracle file tree: `path -> content`.
pub type FileSet = BTreeMap<String, String>;

/// Three-way per-path classification between base, side A, and side B.
///
/// Mirrors the TS `Classification` union. Only the variants the oracle scorer
/// needs to distinguish are materialized as hard conflicts; the rest collapse
/// into descriptive shapes for completeness and testability.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Classification {
    Unchanged,
    AOnly,
    BOnly,
    BothSame,
    BothDifferent,
    AAdded,
    BAdded,
    ADeletedBEdited,
    BDeletedAEdited,
    BothDeleted,
    AAddedBAddedSame,
    AAddedBAddedDiff,
}

/// Classify a single `path` across `base`, `a`, and `b`. Direct port of the TS
/// `classifyPath`.
pub fn classify_path(path: &str, base: &FileSet, a: &FileSet, b: &FileSet) -> Classification {
    let in_base = base.contains_key(path);
    let in_a = a.contains_key(path);
    let in_b = b.contains_key(path);
    let base_c = base.get(path);
    let a_c = a.get(path);
    let b_c = b.get(path);

    if in_base && in_a && in_b {
        if a_c == base_c && b_c == base_c {
            return Classification::Unchanged;
        }
        if a_c == base_c {
            return Classification::BOnly;
        }
        if b_c == base_c {
            return Classification::AOnly;
        }
        if a_c == b_c {
            return Classification::BothSame;
        }
        return Classification::BothDifferent;
    }
    if !in_base && in_a && in_b {
        if a_c == b_c {
            return Classification::AAddedBAddedSame;
        }
        return Classification::AAddedBAddedDiff;
    }
    if !in_base && in_a {
        return Classification::AAdded;
    }
    if !in_base && in_b {
        return Classification::BAdded;
    }
    if in_base && !in_a && in_b {
        if b_c == base_c {
            return Classification::AOnly; // a deleted, b unchanged
        }
        return Classification::ADeletedBEdited;
    }
    if in_base && in_a && !in_b {
        if a_c == base_c {
            return Classification::BOnly; // b deleted, a unchanged
        }
        return Classification::BDeletedAEdited;
    }
    // in_base && !in_a && !in_b
    Classification::BothDeleted
}

/// Score a candidate merged tree against a set of oracle branches.
///
/// Returns the total number of hard conflicts across all oracles. Lower is
/// better. Direct port of the TS `scoreAgainstOracles`.
pub fn score_against_oracles(candidate: &FileSet, base: &FileSet, oracles: &[FileSet]) -> usize {
    let mut total = 0usize;
    for oracle in oracles {
        let mut all_paths: BTreeSet<&String> = BTreeSet::new();
        all_paths.extend(base.keys());
        all_paths.extend(candidate.keys());
        all_paths.extend(oracle.keys());
        for path in &all_paths {
            let c = classify_path(path, base, candidate, oracle);
            if c == Classification::BothDifferent || c == Classification::AAddedBAddedDiff {
                total += 1;
            }
        }
    }
    total
}

/// A named candidate tree, used when Tier 1 emits more than one candidate.
#[derive(Debug, Clone)]
pub struct Candidate {
    /// Stable identifier for the candidate (e.g. `"candidate_0"`).
    pub id: String,
    /// The candidate's file tree.
    pub files: FileSet,
}

/// Outcome of oracle selection over multiple candidates.
#[derive(Debug, Clone)]
pub enum OracleSelection {
    /// A single clear winner with the lowest conflict score.
    Winner { id: String, files: FileSet },
    /// Two or more candidates tied for the lowest score — a Tier 3 dilemma.
    Tied { scored: Vec<(String, usize)> },
}

/// Select the best candidate against the oracle branches.
///
/// Returns `None` when there are fewer than two candidates or no oracle
/// branches (the oracle is a no-op and the caller keeps its single candidate),
/// mirroring the guard in the TS `tier1Merge`. Otherwise returns the clear
/// winner, or a tie that the caller should surface as a Tier 3 dilemma.
pub fn select_candidate(
    candidates: &[Candidate],
    base: &FileSet,
    oracles: &[FileSet],
) -> Option<OracleSelection> {
    if candidates.len() < 2 || oracles.is_empty() {
        return None;
    }
    let mut scored: Vec<(String, usize, &FileSet)> = candidates
        .iter()
        .map(|c| {
            (
                c.id.clone(),
                score_against_oracles(&c.files, base, oracles),
                &c.files,
            )
        })
        .collect();
    // Stable sort by ascending score.
    scored.sort_by_key(|(_, score, _)| *score);
    let best_score = scored[0].1;
    let second_score = scored[1].1;
    if best_score < second_score {
        Some(OracleSelection::Winner {
            id: scored[0].0.clone(),
            files: scored[0].2.clone(),
        })
    } else {
        Some(OracleSelection::Tied {
            scored: scored.into_iter().map(|(id, s, _)| (id, s)).collect(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fs(pairs: &[(&str, &str)]) -> FileSet {
        pairs
            .iter()
            .map(|(p, c)| (p.to_string(), c.to_string()))
            .collect()
    }

    #[test]
    fn classify_unchanged() {
        let base = fs(&[("a", "1")]);
        assert_eq!(
            classify_path("a", &base, &base, &base),
            Classification::Unchanged
        );
    }

    #[test]
    fn classify_both_different() {
        let base = fs(&[("a", "1")]);
        let a = fs(&[("a", "2")]);
        let b = fs(&[("a", "3")]);
        assert_eq!(
            classify_path("a", &base, &a, &b),
            Classification::BothDifferent
        );
    }

    #[test]
    fn classify_added_diff() {
        let base = fs(&[]);
        let a = fs(&[("x", "1")]);
        let b = fs(&[("x", "2")]);
        assert_eq!(
            classify_path("x", &base, &a, &b),
            Classification::AAddedBAddedDiff
        );
    }

    #[test]
    fn score_counts_conflicts() {
        let base = fs(&[("a", "1")]);
        let candidate = fs(&[("a", "2")]);
        let oracle = fs(&[("a", "3")]);
        assert_eq!(score_against_oracles(&candidate, &base, &[oracle]), 1);
    }

    #[test]
    fn score_no_conflict_when_candidate_matches_base() {
        let base = fs(&[("a", "1")]);
        let candidate = fs(&[("a", "1")]);
        let oracle = fs(&[("a", "3")]);
        assert_eq!(score_against_oracles(&candidate, &base, &[oracle]), 0);
    }

    #[test]
    fn select_returns_none_for_single_candidate() {
        let base = fs(&[("a", "1")]);
        let cands = vec![Candidate {
            id: "c0".into(),
            files: fs(&[("a", "2")]),
        }];
        assert!(select_candidate(&cands, &base, &[fs(&[("a", "3")])]).is_none());
    }

    #[test]
    fn select_picks_lower_score() {
        let base = fs(&[("a", "1")]);
        // Oracle changed "a" away from base, so any candidate that also
        // changed "a" (to something different) is a both_different conflict.
        let oracle = fs(&[("a", "9")]);
        let cands = vec![
            Candidate {
                id: "c0".into(),
                files: fs(&[("a", "2")]), // diverges from oracle -> 1 conflict
            },
            Candidate {
                id: "c1".into(),
                files: fs(&[("a", "9")]), // matches oracle -> both_same -> 0 conflicts
            },
        ];
        match select_candidate(&cands, &base, &[oracle]) {
            Some(OracleSelection::Winner { id, .. }) => assert_eq!(id, "c1"),
            other => panic!("expected winner, got {other:?}"),
        }
    }

    #[test]
    fn select_ties_emit_dilemma() {
        let base = fs(&[("a", "1")]);
        let oracle = fs(&[("a", "9")]);
        let cands = vec![
            Candidate {
                id: "c0".into(),
                files: fs(&[("a", "2")]),
            },
            Candidate {
                id: "c1".into(),
                files: fs(&[("a", "3")]),
            },
        ];
        match select_candidate(&cands, &base, &[oracle]) {
            Some(OracleSelection::Tied { scored }) => assert_eq!(scored.len(), 2),
            other => panic!("expected tie, got {other:?}"),
        }
    }
}
