//! Content-hash deduplication for blocks.
//!
//! Mirrors `src/ingest/dedup.ts` (`contentHash`) from the Nexum Node service.
//! Uses SHA-256 of the raw UTF-8 block content, hex-encoded.

use sha2::{Digest, Sha256};

/// Compute the SHA-256 hex digest of `content`.
///
/// This is the canonical content-hash used in the `blocks.content_hash`
/// column to identify unchanged blocks across document versions.  A match
/// means the block text is byte-for-byte identical; the block's existing UUID
/// is reused rather than inserting a duplicate row.
pub fn content_hash(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    hex::encode(hasher.finalize())
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_hash_is_deterministic() {
        let h1 = content_hash("hello world");
        let h2 = content_hash("hello world");
        assert_eq!(h1, h2);
    }

    #[test]
    fn content_hash_differs_for_different_inputs() {
        assert_ne!(content_hash("foo"), content_hash("bar"));
    }

    #[test]
    fn content_hash_is_64_hex_chars() {
        // SHA-256 → 32 bytes → 64 hex chars
        assert_eq!(content_hash("test").len(), 64);
    }

    /// Verify the exact hash for a known input so we can cross-check the
    /// TypeScript implementation in CI.  The expected value is
    /// `crypto.createHash('sha256').update('hello world').digest('hex')`
    /// from Node (and `echo -n "hello world" | sha256sum` on Linux).
    #[test]
    fn content_hash_matches_known_vector() {
        assert_eq!(
            content_hash("hello world"),
            "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
        );
    }
}
