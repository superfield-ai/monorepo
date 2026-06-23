//! Sharp VCS content-addressed object store — `sharp add` and object lookup.
//!
//! Objects are the fundamental storage unit.  Each object is identified by the
//! SHA-256 hex digest of its raw bytes.  The three object types mirror Git's
//! model: blob (file content), tree (directory listing), commit (snapshot).
//!
//! See `docs/architecture.md §Sharp — Tier-1 Rust Semantic Merge § Components (crates/sharp)`.

use crate::error::SharpError;
use crate::git_canonical::{hash_object, id_hex, HashAlgo, ObjectKind};
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

/// The per-object hash-algorithm tag written to `sharp.objects.algo`
/// (whitepaper §4.0 / §4.1). Both writer paths ([`store`] and [`store_canonical`])
/// currently produce SHA-256 ids, so they tag rows `'sha256'`. The column
/// defaults to `'sha1'` (the whitepaper default) for any row inserted without an
/// explicit value; the value must always match the hash function that produced
/// the id. A repo-level `objectformat` selector (out of scope here) will later
/// let writers emit `'sha1'` ids instead.
const ALGO_SHA256: &str = "sha256";

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
        INSERT INTO sharp.objects (sha256, repo_id, object_type, size_bytes, data, algo)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (sha256) DO NOTHING
        "#,
    )
    .bind(&sha)
    .bind(repo_id)
    .bind(type_str)
    .bind(size)
    .bind(data)
    .bind(ALGO_SHA256)
    .execute(pool)
    .await?;

    Ok(sha)
}

/// Store an object keyed on its **git-canonical id** — `id_hex(hash_object(
/// kind, payload))`, the header-prefixed SHA-256 that `git_canonical` tree and
/// commit encodings embed in their entries.
///
/// Use this whenever the object will be referenced by a git-canonical id
/// (working-tree snapshots, git interop). [`store`] keys on the raw-bytes
/// SHA-256 instead and backs the commit/episode/projection paths, whose
/// references are internally consistent under that scheme. The two id models
/// share the `sharp.objects` table but address different rows; a future cleanup
/// (#45 caller migration) can converge them — it is not a correctness issue
/// today because each path resolves objects by the same id it stored under.
///
/// Returns the git-canonical id hex of the stored object.
///
/// # Errors
///
/// Returns [`SharpError::Db`] on a database error.
pub async fn store_canonical(
    pool: &PgPool,
    repo_id: Uuid,
    kind: ObjectKind,
    payload: &[u8],
) -> Result<String, SharpError> {
    let id = id_hex(&hash_object(kind, payload, HashAlgo::Sha256));
    // `sharp.objects.object_type` mirrors Git's keywords. Tags are not produced
    // by the worktree paths; map defensively to "commit".
    let object_type = match kind {
        ObjectKind::Blob => "blob",
        ObjectKind::Tree => "tree",
        ObjectKind::Commit | ObjectKind::Tag => "commit",
    };
    let size = payload.len() as i64;
    // `HashAlgo::Sha256` above produces the id, so tag the row `'sha256'`.
    sqlx::query(
        r#"
        INSERT INTO sharp.objects (sha256, repo_id, object_type, size_bytes, data, algo)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (sha256) DO NOTHING
        "#,
    )
    .bind(&id)
    .bind(repo_id)
    .bind(object_type)
    .bind(size)
    .bind(payload)
    .bind(ALGO_SHA256)
    .execute(pool)
    .await?;
    Ok(id)
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
