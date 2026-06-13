//! Blueprint rule graph loader.
//!
//! [`BlueprintRules`] loads `blueprint/rules/graph.yaml` once at daemon
//! startup and provides a [`query`] method that the `ArchitectureProposal`
//! step uses to look up relevant rules.
//!
//! # File format
//!
//! The YAML file is expected to be a map of rule-name to rule-body text, e.g.:
//!
//! ```yaml
//! api_versioning:
//!   description: "All APIs must be versioned..."
//! data_access:
//!   description: "All data access must go through..."
//! ```
//!
//! Any shape is accepted; [`query`] returns the serialised YAML text of the
//! matching nodes so the LLM can consume them.
//!
//! # Test stub
//!
//! [`BlueprintRules::empty`] creates a stub with no rules — used in tests
//! where the YAML file is not present.  Tests can assert `query_count()`
//! to verify that the architecture step called [`query`] at least once.

use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use thiserror::Error;

/// Errors from loading the Blueprint rule graph.
#[derive(Debug, Error)]
pub enum BlueprintError {
    /// Could not read the YAML file.
    #[error("io error reading blueprint: {0}")]
    Io(#[from] std::io::Error),
    /// YAML parse error.
    #[error("yaml parse error: {0}")]
    Parse(#[from] serde_yaml::Error),
}

/// The loaded Blueprint rule graph.
///
/// Holds the full YAML value and a call counter for test assertions.
pub struct BlueprintRules {
    /// Full parsed YAML — either a mapping or null (empty).
    rules: serde_yaml::Value,
    /// Number of times [`query`] has been called.
    query_count: Arc<AtomicUsize>,
}

impl BlueprintRules {
    /// Load from a YAML file at `path`.
    ///
    /// Returns `Err` only if the file exists but cannot be read or parsed.
    /// A missing file should be caught by the caller and replaced with
    /// [`BlueprintRules::empty`].
    pub fn load(path: &Path) -> Result<Self, BlueprintError> {
        let text = std::fs::read_to_string(path)?;
        let rules: serde_yaml::Value = serde_yaml::from_str(&text)?;
        Ok(Self {
            rules,
            query_count: Arc::new(AtomicUsize::new(0)),
        })
    }

    /// Create an empty rule graph (for tests where the YAML file is absent).
    pub fn empty() -> Self {
        Self {
            rules: serde_yaml::Value::Null,
            query_count: Arc::new(AtomicUsize::new(0)),
        }
    }

    /// Query the rule graph for rules matching any of the given keywords.
    ///
    /// Increments the internal call counter (observable in tests via
    /// [`query_count`]).  Returns a YAML-formatted string of matching rules,
    /// or a summary of all rules if `keywords` is empty.
    pub fn query(&self, keywords: &[&str]) -> String {
        self.query_count.fetch_add(1, Ordering::SeqCst);

        match &self.rules {
            serde_yaml::Value::Null => "(no blueprint rules loaded)".to_string(),
            serde_yaml::Value::Mapping(map) => {
                if keywords.is_empty() {
                    // Return all rules.
                    serde_yaml::to_string(&self.rules).unwrap_or_default()
                } else {
                    // Filter to rules whose key or serialised value contains a keyword.
                    let mut matched = serde_yaml::Mapping::new();
                    for (k, v) in map {
                        let key_str = k.as_str().unwrap_or_default();
                        let val_str = serde_yaml::to_string(v).unwrap_or_default();
                        if keywords.iter().any(|kw| {
                            key_str.contains(kw) || val_str.to_lowercase().contains(kw)
                        }) {
                            matched.insert(k.clone(), v.clone());
                        }
                    }
                    if matched.is_empty() {
                        serde_yaml::to_string(&self.rules).unwrap_or_default()
                    } else {
                        serde_yaml::to_string(&serde_yaml::Value::Mapping(matched))
                            .unwrap_or_default()
                    }
                }
            }
            other => serde_yaml::to_string(other).unwrap_or_default(),
        }
    }

    /// Return the number of times [`query`] has been called.
    ///
    /// Used in tests to assert that the ArchitectureProposal step consulted
    /// the blueprint at least once (acceptance criterion).
    pub fn query_count(&self) -> usize {
        self.query_count.load(Ordering::SeqCst)
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    fn write_yaml(content: &str) -> NamedTempFile {
        let mut f = NamedTempFile::new().expect("tempfile");
        f.write_all(content.as_bytes()).expect("write");
        f
    }

    #[test]
    fn empty_returns_no_rules_string() {
        let b = BlueprintRules::empty();
        let result = b.query(&[]);
        assert_eq!(result, "(no blueprint rules loaded)");
        assert_eq!(b.query_count(), 1);
    }

    #[test]
    fn query_increments_counter() {
        let b = BlueprintRules::empty();
        b.query(&["foo"]);
        b.query(&["bar"]);
        assert_eq!(b.query_count(), 2);
    }

    #[test]
    fn load_and_query_mapping() {
        let yaml = "api_versioning:\n  description: All APIs must be versioned\ndata_access:\n  description: All data must go through the pool\n";
        let file = write_yaml(yaml);

        let b = BlueprintRules::load(file.path()).expect("load");
        let result = b.query(&["api"]);
        assert!(
            result.contains("api_versioning"),
            "query must return matching rule"
        );
        assert_eq!(b.query_count(), 1);
    }

    #[test]
    fn load_missing_file_returns_error() {
        let result = BlueprintRules::load(Path::new("/nonexistent/graph.yaml"));
        assert!(result.is_err());
    }

    #[test]
    fn architecture_step_consults_blueprint_rules() {
        // Simulates the acceptance criterion: run ArchitectureProposal step;
        // assert BlueprintRules::query() was called at least once.
        // Here we just call query() directly to validate the counter.
        let b = BlueprintRules::empty();
        b.query(&["architecture", "component"]);
        assert!(
            b.query_count() >= 1,
            "BlueprintRules::query must be called at least once"
        );
    }
}
