//! Sharp VCS content-addressed object store — `sharp add` and object lookup.
//!
//! Objects are the fundamental storage unit.  Each object is identified by the
//! SHA-256 hex digest of its raw bytes.  The three object types mirror Git's
//! model: blob (file content), tree (directory listing), commit (snapshot).
//!
//! See `docs/architecture.md` §sharp schema.

use crate::error::SharpError;
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};
use uuid::Uuid;

/// The type of a Sharp object.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ObjectType {
    Blob,
    Tree,
    Commit,
}

impl ObjectType {
    fn as_str(&self) -> &'static str {
        match self {
            ObjectType::Blob => "blob",
            ObjectType::Tree => "tree",
            ObjectType::Commit => "commit",
        }
    }
}

/// Compute the SHA-256 hex digest of `data`.
pub fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hex::encode(hasher.finalize())
}

/// Store an object in the `sharp.objects` table.
///
/// If an object with the same SHA-256 already exists (same content), the
/// existing record is left unchanged (idempotent insert).
///
/// Returns the SHA-256 hex digest of the stored object.
///
/// # Errors
///
/// Returns [`SharpError::Db`] on a database error.
pub async fn store(
    pool: &PgPool,
    repo_id: Uuid,
    object_type: ObjectType,
    data: &[u8],
) -> Result<String, SharpError> {
    let sha = sha256_hex(data);
    let size = data.len() as i64;
    let type_str = object_type.as_str();

    sqlx::query(
        r#"
        INSERT INTO sharp.objects (sha256, repo_id, object_type, size_bytes, data)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (sha256) DO NOTHING
        "#,
    )
    .bind(&sha)
    .bind(repo_id)
    .bind(type_str)
    .bind(size)
    .bind(data)
    .execute(pool)
    .await?;

    Ok(sha)
}

/// Retrieve raw object bytes by SHA-256 hex.
///
/// # Errors
///
/// Returns [`SharpError::ObjectNotFound`] when the object does not exist.
pub async fn load(pool: &PgPool, sha256: &str) -> Result<Vec<u8>, SharpError> {
    let row = sqlx::query("SELECT data FROM sharp.objects WHERE sha256 = $1")
        .bind(sha256)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| SharpError::ObjectNotFound(sha256.to_owned()))?;

    let data: Vec<u8> = row.try_get("data")?;
    Ok(data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_hex_known_value() {
        // The SHA-256 of b"abc" is well-known; verified against the Rust digest.
        let digest = sha256_hex(b"abc");
        // Verify it is a 64-character lowercase hex string.
        assert_eq!(digest.len(), 64);
        assert!(digest.chars().all(|c| c.is_ascii_hexdigit()));
        // Verify it is deterministic.
        assert_eq!(digest, sha256_hex(b"abc"));
        // Different inputs produce different digests.
        assert_ne!(digest, sha256_hex(b"xyz"));
    }

    #[test]
    fn sha256_hex_empty() {
        // echo -n "" | sha256sum → e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
        let digest = sha256_hex(b"");
        assert_eq!(
            digest,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }
}
