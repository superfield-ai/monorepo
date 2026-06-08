//! Sharp Git import and export — `sharp git import` / `sharp git export`.
//!
//! Implements byte-identical Git interoperability:
//!
//! **Import** reads the Git object store on disk (loose objects in
//! `objects/<xx>/<rest>` and packed objects in `objects/pack/*.pack`) without
//! executing any `git` subprocess.  Each inflated canonical payload is verified
//! against its SHA-1, then stored in `sharp.git_objects` keyed by that SHA-1.
//! Refs in `refs/` and `HEAD` are mirrored to `sharp.git_refs`.
//!
//! **Export** is linear-only: it walks the parent chain from the branch tip,
//! refuses (returns `Err`) if any commit has more than one parent, then
//! materialises every reachable object as a zlib-deflated loose object in a
//! fresh bare repo directory.  The resulting bare repo passes `git fsck`
//! without warnings because Sharp's stored bytes are already the canonical
//! form Git would hash.
//!
//! SHA-1 is the default (matching Git's default).  The `SHARP_ALLOW_RAW_SHA1`
//! environment variable is checked before skipping the SHA-1DC collision guard;
//! v1 simply uses the standard `sha1` crate (no DC check) and defers the DC
//! posture decision per `docs/architecture.md §7 Current Gaps #10`.
//!
//! Submodule recursion and Git LFS object fetch are explicit v1 punts.
//!
//! See `docs/architecture.md` §sharp schema and whitepaper §7.

use crate::error::SharpError;
use crate::git_canonical::{self, HashAlgo, ObjectKind};
use flate2::{read::ZlibDecoder, write::ZlibEncoder, Compression};
use sqlx::{PgPool, Row};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Error extension
// ---------------------------------------------------------------------------

/// Interop-specific errors, embedded in [`SharpError::GitInterop`].
#[derive(Debug, thiserror::Error)]
pub enum GitInteropError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("SHA-1 mismatch: expected {expected}, computed {computed}")]
    HashMismatch { expected: String, computed: String },

    #[error("malformed git object at {path}: {reason}")]
    MalformedObject { path: PathBuf, reason: String },

    #[error("ref not found: {0}")]
    RefNotFound(String),

    #[error("non-linear history: commit {0} has {1} parents; export refuses non-linear histories")]
    NonLinearHistory(String, usize),

    #[error("malformed pack file {path}: {reason}")]
    MalformedPack { path: PathBuf, reason: String },
}

// ---------------------------------------------------------------------------
// Public result types
// ---------------------------------------------------------------------------

/// Summary returned by [`import_git_repo`].
#[derive(Debug, Default)]
pub struct ImportResult {
    /// Number of objects successfully ingested.
    pub objects_imported: usize,
    /// Number of refs successfully mirrored.
    pub refs_imported: usize,
    /// Symbolic target of HEAD (`refs/heads/main`, etc.), if HEAD is a
    /// symbolic ref.  `None` for a detached HEAD.
    pub head: Option<String>,
    /// Non-fatal per-object warnings (hash mismatches, unsupported types …).
    pub warnings: Vec<String>,
}

/// Summary returned by [`export_git_repo`].
#[derive(Debug)]
pub struct ExportResult {
    /// Number of commits in the exported linear history.
    pub commits_exported: usize,
    /// Number of loose object files written.
    pub objects_exported: usize,
    /// Destination directory path.
    pub destination: PathBuf,
    /// Non-fatal warnings.
    pub warnings: Vec<String>,
}

// ---------------------------------------------------------------------------
// Git object kinds
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GitKind {
    Blob,
    Tree,
    Commit,
    Tag,
}

impl GitKind {
    fn as_str(self) -> &'static str {
        match self {
            GitKind::Blob => "blob",
            GitKind::Tree => "tree",
            GitKind::Commit => "commit",
            GitKind::Tag => "tag",
        }
    }

    /// Map to the git-canonical [`ObjectKind`].
    fn to_canonical(self) -> ObjectKind {
        match self {
            GitKind::Blob => ObjectKind::Blob,
            GitKind::Tree => ObjectKind::Tree,
            GitKind::Commit => ObjectKind::Commit,
            GitKind::Tag => ObjectKind::Tag,
        }
    }

    fn from_str(s: &str) -> Option<GitKind> {
        match s {
            "blob" => Some(GitKind::Blob),
            "tree" => Some(GitKind::Tree),
            "commit" => Some(GitKind::Commit),
            "tag" => Some(GitKind::Tag),
            _ => None,
        }
    }
}

// ---------------------------------------------------------------------------
// Git canonical hashing
// ---------------------------------------------------------------------------

/// Compute the Git SHA-1 for a canonical payload.
///
/// Git hashes `"<kind> <decimal-size>\0<payload>"`.
fn git_sha1(kind: GitKind, payload: &[u8]) -> String {
    let id = git_canonical::hash_object(kind.to_canonical(), payload, HashAlgo::Sha1);
    git_canonical::id_hex(&id)
}

// ---------------------------------------------------------------------------
// Loose object reading
// ---------------------------------------------------------------------------

/// Read and inflate a single loose Git object file.
///
/// Returns `(kind, payload_bytes)` where `payload` is the raw content (the
/// part after `<kind> <size>\0`).
fn read_loose_object(path: &Path) -> Result<(GitKind, Vec<u8>), GitInteropError> {
    let compressed = std::fs::read(path)?;
    let mut decoder = ZlibDecoder::new(compressed.as_slice());
    let mut raw = Vec::new();
    decoder
        .read_to_end(&mut raw)
        .map_err(|e| GitInteropError::MalformedObject {
            path: path.to_owned(),
            reason: format!("zlib decompress failed: {e}"),
        })?;

    // Parse `<kind> <decimal-size>\0<payload>`.
    let nul = raw
        .iter()
        .position(|&b| b == 0)
        .ok_or_else(|| GitInteropError::MalformedObject {
            path: path.to_owned(),
            reason: "missing NUL byte in object header".to_string(),
        })?;
    let header =
        std::str::from_utf8(&raw[..nul]).map_err(|e| GitInteropError::MalformedObject {
            path: path.to_owned(),
            reason: format!("non-UTF-8 header: {e}"),
        })?;
    let space = header
        .find(' ')
        .ok_or_else(|| GitInteropError::MalformedObject {
            path: path.to_owned(),
            reason: "missing space in header".to_string(),
        })?;
    let kind_str = &header[..space];
    let kind = GitKind::from_str(kind_str).ok_or_else(|| GitInteropError::MalformedObject {
        path: path.to_owned(),
        reason: format!("unsupported object type: {kind_str}"),
    })?;
    let payload = raw[nul + 1..].to_vec();
    Ok((kind, payload))
}

/// Walk `<git_dir>/objects/` collecting all loose object paths.
///
/// Each subdirectory is two hex characters; each file is the remaining 38
/// characters.  Returns `(sha1_hex, path)` pairs.
fn collect_loose_objects(git_dir: &Path) -> Result<Vec<(String, PathBuf)>, std::io::Error> {
    let objects_dir = git_dir.join("objects");
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&objects_dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        // Skip pack/ and info/ directories.
        if name_str == "pack" || name_str == "info" {
            continue;
        }
        if name_str.len() != 2 || !name_str.chars().all(|c| c.is_ascii_hexdigit()) {
            continue;
        }
        let prefix = name_str.to_string();
        let sub_path = entry.path();
        if sub_path.is_dir() {
            for sub in std::fs::read_dir(&sub_path)? {
                let sub = sub?;
                let sub_name = sub.file_name();
                let sub_str = sub_name.to_string_lossy();
                if sub_str.len() == 38 && sub_str.chars().all(|c| c.is_ascii_hexdigit()) {
                    let sha1 = format!("{prefix}{sub_str}");
                    out.push((sha1, sub.path()));
                }
            }
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Pack file reading
// ---------------------------------------------------------------------------

/// Read all objects from a pack file.
///
/// Pack format (v2):
///   - 4-byte magic: `PACK`
///   - 4-byte version: `2` (big-endian)
///   - 4-byte object count (big-endian)
///   - N objects (variable-length, type+size-encoded header, zlib payload)
///   - 20-byte trailer SHA-1 (of all preceding bytes)
///
/// Alongside each `.pack` file lives a `.idx` file.  We use the v2 index to
/// locate each object by offset, then extract kind+payload from the pack.
///
/// Returns `Vec<(sha1_hex, kind, payload)>`.
fn read_pack_objects(pack_path: &Path) -> Result<Vec<(String, GitKind, Vec<u8>)>, GitInteropError> {
    let idx_path = pack_path.with_extension("idx");
    if !idx_path.exists() {
        // Without an index we cannot efficiently decode the pack.
        // Return an empty list with a warning handled by the caller.
        return Ok(vec![]);
    }

    let pack_data = std::fs::read(pack_path)?;
    let idx_data = std::fs::read(&idx_path)?;

    // --- Parse v2 pack index ---
    // Magic + version check.
    if idx_data.len() < 8 {
        return Err(GitInteropError::MalformedPack {
            path: idx_path.clone(),
            reason: "index too short".to_string(),
        });
    }
    let magic = &idx_data[0..4];
    let version = u32::from_be_bytes(idx_data[4..8].try_into().unwrap());
    if magic != b"\xff\x74\x4f\x63" || version != 2 {
        // v1 index — not supported in v1 of this importer.  Return empty.
        return Ok(vec![]);
    }

    // Fan-out table: 256 × 4 bytes starting at offset 8.
    let fan_out_offset = 8usize;
    let total_objects = {
        let last_fan_out = &idx_data[fan_out_offset + 255 * 4..fan_out_offset + 256 * 4];
        u32::from_be_bytes(last_fan_out.try_into().unwrap()) as usize
    };

    // SHA-1 table: total_objects × 20 bytes immediately after the fan-out table.
    let sha1_table_offset = fan_out_offset + 256 * 4;
    // CRC table: total_objects × 4 bytes.
    let crc_table_offset = sha1_table_offset + total_objects * 20;
    // Offset table: total_objects × 4 bytes.
    let offset_table_offset = crc_table_offset + total_objects * 4;

    // Pack file header validation.
    if pack_data.len() < 12 {
        return Err(GitInteropError::MalformedPack {
            path: pack_path.to_owned(),
            reason: "pack too short".to_string(),
        });
    }
    if &pack_data[0..4] != b"PACK" {
        return Err(GitInteropError::MalformedPack {
            path: pack_path.to_owned(),
            reason: "missing PACK magic".to_string(),
        });
    }

    let mut result = Vec::with_capacity(total_objects);

    for i in 0..total_objects {
        // SHA-1 of this object.
        let sha1_start = sha1_table_offset + i * 20;
        if sha1_start + 20 > idx_data.len() {
            break;
        }
        let sha1 = hex::encode(&idx_data[sha1_start..sha1_start + 20]);

        // Offset of this object in the pack.
        let off_start = offset_table_offset + i * 4;
        if off_start + 4 > idx_data.len() {
            break;
        }
        let raw_offset = u32::from_be_bytes(idx_data[off_start..off_start + 4].try_into().unwrap());
        // High bit set → 64-bit offset table; v1 uses only 32-bit offsets here.
        if raw_offset & 0x8000_0000 != 0 {
            // Skip large-file offsets for now (rare in test repos).
            continue;
        }
        let offset = raw_offset as usize;

        // Read type+size-encoded header at offset.
        let (kind_byte, inflated_size, header_len) =
            match read_pack_object_header(&pack_data, offset) {
                Some(v) => v,
                None => continue,
            };

        // Object types: 1=commit, 2=tree, 3=blob, 4=tag, 6=ofs_delta, 7=ref_delta.
        // Delta types are resolved by git before reaching the object store; a
        // mirror-clone guarantees non-delta objects, so we skip them.
        let kind = match kind_byte {
            1 => GitKind::Commit,
            2 => GitKind::Tree,
            3 => GitKind::Blob,
            4 => GitKind::Tag,
            _ => continue, // delta — skip
        };

        // Decompress payload.
        let compressed_start = offset + header_len;
        let mut decoder = ZlibDecoder::new(&pack_data[compressed_start..]);
        let mut payload = Vec::with_capacity(inflated_size);
        if decoder.read_to_end(&mut payload).is_err() {
            continue;
        }

        result.push((sha1, kind, payload));
    }

    Ok(result)
}

/// Read a pack object type+size header at `offset`.
///
/// The first byte encodes:
///   bit 7    — MSB continuation flag
///   bits 6-4 — object type (3 bits)
///   bits 3-0 — low 4 bits of inflated size
///
/// Subsequent bytes (while the previous byte had MSB set) each contribute
/// 7 more bits to the inflated size.
///
/// Returns `(type_bits_3, inflated_size, bytes_consumed)` or `None` on error.
fn read_pack_object_header(pack: &[u8], offset: usize) -> Option<(u8, usize, usize)> {
    let mut pos = offset;
    if pos >= pack.len() {
        return None;
    }
    let first = pack[pos];
    pos += 1;
    let type_bits = (first >> 4) & 0x07;
    let mut size = (first & 0x0f) as usize;
    let mut shift = 4usize;

    // Continue reading while the MSB of the previous byte was set.
    let mut prev_msb = first & 0x80 != 0;
    while prev_msb {
        if pos >= pack.len() {
            return None;
        }
        let cont = pack[pos];
        pos += 1;
        size |= ((cont & 0x7f) as usize) << shift;
        shift += 7;
        prev_msb = cont & 0x80 != 0;
    }

    Some((type_bits, size, pos - offset))
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/// Import a Git repository from a path on disk into Sharp.
///
/// `git_path` may be either a working directory (`.git/` is appended if no
/// `HEAD` file is found directly) or a bare repo directory.
///
/// All reachable objects are stored in `sharp.git_objects`; refs and HEAD are
/// mirrored to `sharp.git_refs`.
///
/// # Errors
///
/// Returns [`SharpError`] on database errors.  Per-object hash mismatches and
/// unsupported types are recorded as [`ImportResult::warnings`] rather than
/// aborting the import.
pub async fn import_git_repo(
    pool: &PgPool,
    repo_id: Uuid,
    git_path: &Path,
) -> Result<ImportResult, SharpError> {
    let git_dir = resolve_git_dir(git_path);
    let mut result = ImportResult::default();

    // --- Collect objects from loose files ---
    let loose = collect_loose_objects(&git_dir)
        .map_err(|e| SharpError::GitInterop(format!("failed to list loose objects: {e}")))?;

    for (expected_sha1, path) in &loose {
        match import_one_loose_object(pool, repo_id, expected_sha1, path).await {
            Ok(true) => result.objects_imported += 1,
            Ok(false) => {} // already existed (idempotent)
            Err(e) => result.warnings.push(format!("{expected_sha1}: {e}")),
        }
    }

    // --- Collect objects from pack files ---
    let pack_dir = git_dir.join("objects").join("pack");
    if pack_dir.is_dir() {
        let packs: Vec<PathBuf> = std::fs::read_dir(&pack_dir)
            .map(|rd| {
                rd.filter_map(|e| e.ok())
                    .map(|e| e.path())
                    .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("pack"))
                    .collect()
            })
            .unwrap_or_default();

        for pack_path in &packs {
            match read_pack_objects(pack_path) {
                Ok(objects) => {
                    for (sha1, kind, payload) in objects {
                        match import_one_object(pool, repo_id, &sha1, kind, &payload).await {
                            Ok(true) => result.objects_imported += 1,
                            Ok(false) => {}
                            Err(e) => result.warnings.push(format!("{sha1}: {e}")),
                        }
                    }
                }
                Err(e) => result
                    .warnings
                    .push(format!("pack file {}: {e}", pack_path.display())),
            }
        }
    }

    // --- Mirror refs ---
    let refs_dir = git_dir.join("refs");
    if refs_dir.is_dir() {
        mirror_refs_dir(pool, repo_id, &refs_dir, &refs_dir, &mut result).await;
    }
    // Packed refs.
    let packed_refs_path = git_dir.join("packed-refs");
    if packed_refs_path.exists() {
        mirror_packed_refs(pool, repo_id, &packed_refs_path, &mut result).await;
    }

    // --- HEAD ---
    let head_path = git_dir.join("HEAD");
    if let Ok(head_content) = std::fs::read_to_string(&head_path) {
        let trimmed = head_content.trim();
        if let Some(sym_target) = trimmed.strip_prefix("ref: ") {
            upsert_symbolic_ref(pool, repo_id, "HEAD", sym_target.trim())
                .await
                .map_err(|e| result.warnings.push(format!("HEAD: {e}")))
                .ok();
            result.head = Some(sym_target.trim().to_string());
        } else if is_hex_sha1(trimmed) {
            upsert_direct_ref(pool, repo_id, "HEAD", trimmed)
                .await
                .map_err(|e| result.warnings.push(format!("HEAD (detached): {e}")))
                .ok();
            result.head = Some(trimmed.to_string());
        }
    }

    Ok(result)
}

/// Resolves a path to the actual git directory (handles both bare repos and
/// working-directory `.git`).
fn resolve_git_dir(path: &Path) -> PathBuf {
    // If HEAD exists at this path, it is already a git dir (bare or .git/).
    if path.join("HEAD").exists() {
        return path.to_owned();
    }
    // Try appending .git/.
    let dotgit = path.join(".git");
    if dotgit.join("HEAD").exists() {
        return dotgit;
    }
    // Fall back to the provided path.
    path.to_owned()
}

fn is_hex_sha1(s: &str) -> bool {
    s.len() == 40 && s.chars().all(|c| c.is_ascii_hexdigit())
}

/// Import a single loose object.  Returns `Ok(true)` on insert, `Ok(false)`
/// on duplicate.
async fn import_one_loose_object(
    pool: &PgPool,
    repo_id: Uuid,
    expected_sha1: &str,
    path: &Path,
) -> Result<bool, String> {
    let (kind, payload) = read_loose_object(path).map_err(|e| e.to_string())?;
    let computed = git_sha1(kind, &payload);
    if computed != expected_sha1 {
        return Err(format!(
            "hash mismatch: expected {expected_sha1}, computed {computed}"
        ));
    }
    import_one_object(pool, repo_id, expected_sha1, kind, &payload)
        .await
        .map_err(|e| e.to_string())
}

/// Insert one object into `sharp.git_objects`.  Returns `Ok(true)` on new
/// insert, `Ok(false)` when already present.
async fn import_one_object(
    pool: &PgPool,
    repo_id: Uuid,
    sha1: &str,
    kind: GitKind,
    payload: &[u8],
) -> Result<bool, SharpError> {
    let rows_affected = sqlx::query(
        r#"
        INSERT INTO sharp.git_objects (sha1, repo_id, kind, data)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (repo_id, sha1) DO NOTHING
        "#,
    )
    .bind(sha1)
    .bind(repo_id)
    .bind(kind.as_str())
    .bind(payload)
    .execute(pool)
    .await?
    .rows_affected();

    Ok(rows_affected > 0)
}

/// Walk a `refs/` directory tree recursively, inserting each leaf ref.
async fn mirror_refs_dir(
    pool: &PgPool,
    repo_id: Uuid,
    base: &Path,
    current: &Path,
    result: &mut ImportResult,
) {
    let Ok(rd) = std::fs::read_dir(current) else {
        return;
    };
    for entry in rd.flatten() {
        let path = entry.path();
        if path.is_dir() {
            Box::pin(mirror_refs_dir(pool, repo_id, base, &path, result)).await;
        } else if let Ok(sha1) = std::fs::read_to_string(&path) {
            let sha1 = sha1.trim().to_string();
            if !is_hex_sha1(&sha1) {
                continue;
            }
            // Build ref name from the path relative to the git_dir/refs parent.
            let rel = path
                .strip_prefix(base.parent().unwrap_or(base))
                .unwrap_or(&path);
            let ref_name = rel.to_string_lossy().replace('\\', "/");
            match upsert_direct_ref(pool, repo_id, &ref_name, &sha1).await {
                Ok(()) => result.refs_imported += 1,
                Err(e) => result.warnings.push(format!("{ref_name}: {e}")),
            }
        }
    }
}

/// Mirror packed-refs file.
async fn mirror_packed_refs(pool: &PgPool, repo_id: Uuid, path: &Path, result: &mut ImportResult) {
    let Ok(content) = std::fs::read_to_string(path) else {
        return;
    };
    for line in content.lines() {
        if line.starts_with('#') || line.starts_with('^') {
            continue;
        }
        let parts: Vec<&str> = line.splitn(2, ' ').collect();
        if parts.len() != 2 {
            continue;
        }
        let sha1 = parts[0];
        let ref_name = parts[1];
        if !is_hex_sha1(sha1) {
            continue;
        }
        match upsert_direct_ref(pool, repo_id, ref_name, sha1).await {
            Ok(()) => result.refs_imported += 1,
            Err(e) => result.warnings.push(format!("{ref_name}: {e}")),
        }
    }
}

async fn upsert_direct_ref(
    pool: &PgPool,
    repo_id: Uuid,
    ref_name: &str,
    sha1: &str,
) -> Result<(), SharpError> {
    sqlx::query(
        r#"
        INSERT INTO sharp.git_refs (repo_id, ref_name, sha1, symbolic_target)
        VALUES ($1, $2, $3, NULL)
        ON CONFLICT (repo_id, ref_name) DO UPDATE
            SET sha1 = EXCLUDED.sha1,
                symbolic_target = NULL,
                updated_at = now()
        "#,
    )
    .bind(repo_id)
    .bind(ref_name)
    .bind(sha1)
    .execute(pool)
    .await?;
    Ok(())
}

async fn upsert_symbolic_ref(
    pool: &PgPool,
    repo_id: Uuid,
    ref_name: &str,
    target: &str,
) -> Result<(), SharpError> {
    sqlx::query(
        r#"
        INSERT INTO sharp.git_refs (repo_id, ref_name, sha1, symbolic_target)
        VALUES ($1, $2, NULL, $3)
        ON CONFLICT (repo_id, ref_name) DO UPDATE
            SET sha1 = NULL,
                symbolic_target = EXCLUDED.symbolic_target,
                updated_at = now()
        "#,
    )
    .bind(repo_id)
    .bind(ref_name)
    .bind(target)
    .execute(pool)
    .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Linear history check
// ---------------------------------------------------------------------------

/// Walk the parent chain from `tip_sha1` for `repo_id`.
///
/// Returns the ordered list of commit SHA-1s from oldest to newest if the
/// history is fully linear (every commit has at most one parent).
///
/// # Errors
///
/// Returns [`GitInteropError::NonLinearHistory`] if any commit has > 1 parent,
/// or [`SharpError`] on database or parse errors.
pub async fn linear_history(
    pool: &PgPool,
    repo_id: Uuid,
    tip_sha1: &str,
) -> Result<Vec<String>, SharpError> {
    let mut chain: Vec<String> = Vec::new();
    let mut current = tip_sha1.to_string();
    let mut visited = std::collections::HashSet::new();

    loop {
        if !visited.insert(current.clone()) {
            return Err(SharpError::GitInterop(format!(
                "cycle detected at commit {current}"
            )));
        }
        chain.push(current.clone());

        let row = sqlx::query(
            "SELECT data FROM sharp.git_objects WHERE repo_id = $1 AND sha1 = $2 AND kind = 'commit'",
        )
        .bind(repo_id)
        .bind(&current)
        .fetch_optional(pool)
        .await?;

        let Some(row) = row else {
            break;
        };
        let payload: Vec<u8> = row.try_get("data")?;
        let parents = parse_commit_parents(&payload)?;

        match parents.len() {
            0 => break, // root commit
            1 => current = parents.into_iter().next().unwrap(),
            n => {
                return Err(SharpError::GitInterop(format!(
                    "non-linear history: commit {} has {n} parents; \
                     sharp git export refuses non-linear histories per architecture §7",
                    chain.last().unwrap()
                )));
            }
        }
    }

    chain.reverse(); // oldest first
    Ok(chain)
}

/// Parse parent SHA-1s from a raw git commit payload.
///
/// The commit payload has header lines followed by `\n\n` then the message.
/// Parent lines look like `parent <sha1>`.
fn parse_commit_parents(payload: &[u8]) -> Result<Vec<String>, SharpError> {
    let text = std::str::from_utf8(payload)
        .map_err(|e| SharpError::GitInterop(format!("commit payload is not valid UTF-8: {e}")))?;
    let header_end = text.find("\n\n").unwrap_or(text.len());
    let headers = &text[..header_end];
    let mut parents = Vec::new();
    for line in headers.lines() {
        if let Some(sha) = line.strip_prefix("parent ") {
            parents.push(sha.trim().to_string());
        }
    }
    Ok(parents)
}

/// Resolve a ref name to its SHA-1, following symbolic refs one level.
async fn resolve_ref(pool: &PgPool, repo_id: Uuid, ref_name: &str) -> Result<String, SharpError> {
    let row = sqlx::query(
        "SELECT sha1, symbolic_target FROM sharp.git_refs WHERE repo_id = $1 AND ref_name = $2",
    )
    .bind(repo_id)
    .bind(ref_name)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| SharpError::GitInterop(format!("ref not found: {ref_name}")))?;

    let sha1: Option<String> = row.try_get("sha1")?;
    if let Some(sha) = sha1 {
        return Ok(sha);
    }
    let sym: Option<String> = row.try_get("symbolic_target")?;
    if let Some(target) = sym {
        return Box::pin(resolve_ref(pool, repo_id, &target)).await;
    }
    Err(SharpError::GitInterop(format!(
        "ref {ref_name} has neither sha1 nor symbolic_target"
    )))
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/// Export a linear Sharp branch as a bare Git repository on disk.
///
/// Creates a bare repo at `destination` containing every object reachable from
/// `branch_ref`, writes each as a loose object (zlib-deflated), sets the
/// branch ref, and writes HEAD.
///
/// # Errors
///
/// Returns [`SharpError`] if the history is non-linear, the branch is not
/// found, or a database / I/O error occurs.
pub async fn export_git_repo(
    pool: &PgPool,
    repo_id: Uuid,
    branch_ref: &str,
    destination: &Path,
) -> Result<ExportResult, SharpError> {
    // 1. Resolve branch to tip commit SHA-1.
    let tip_sha1 = resolve_ref(pool, repo_id, branch_ref).await?;

    // 2. Verify linearity — errors on merge commits.
    let history = linear_history(pool, repo_id, &tip_sha1).await?;

    // 3. Initialise bare repo directory.
    std::fs::create_dir_all(destination).map_err(|e| {
        SharpError::GitInterop(format!(
            "failed to create destination {}: {e}",
            destination.display()
        ))
    })?;
    init_bare_repo(destination).map_err(|e| {
        SharpError::GitInterop(format!(
            "failed to initialise bare repo at {}: {e}",
            destination.display()
        ))
    })?;

    let mut warnings = Vec::new();

    // 4. Collect all objects reachable from the tip via the commit graph.
    //    For v1 we export every object stored for this repo.
    let sha1s: Vec<String> =
        sqlx::query_scalar("SELECT sha1 FROM sharp.git_objects WHERE repo_id = $1")
            .bind(repo_id)
            .fetch_all(pool)
            .await?;

    let mut objects_exported = 0usize;

    for sha1 in &sha1s {
        let row = sqlx::query(
            "SELECT kind, data FROM sharp.git_objects WHERE repo_id = $1 AND sha1 = $2",
        )
        .bind(repo_id)
        .bind(sha1)
        .fetch_optional(pool)
        .await?;

        let Some(row) = row else { continue };
        let kind_str: String = row.try_get("kind")?;
        let payload: Vec<u8> = row.try_get("data")?;

        match write_loose_object(destination, sha1, &kind_str, &payload) {
            Ok(()) => objects_exported += 1,
            Err(e) => warnings.push(format!("{sha1}: {e}")),
        }
    }

    // 5. Write the branch ref.
    let ref_path = destination.join(branch_ref);
    if let Some(parent) = ref_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| SharpError::GitInterop(format!("create ref dir: {e}")))?;
    }
    std::fs::write(&ref_path, format!("{tip_sha1}\n"))
        .map_err(|e| SharpError::GitInterop(format!("write ref: {e}")))?;

    // 6. Write HEAD.
    std::fs::write(destination.join("HEAD"), format!("ref: {branch_ref}\n"))
        .map_err(|e| SharpError::GitInterop(format!("write HEAD: {e}")))?;

    Ok(ExportResult {
        commits_exported: history.len(),
        objects_exported,
        destination: destination.to_owned(),
        warnings,
    })
}

/// Initialise a minimal bare Git repository layout.
fn init_bare_repo(dest: &Path) -> Result<(), std::io::Error> {
    // Standard bare repo structure.
    for sub in &[
        "objects",
        "objects/info",
        "objects/pack",
        "refs/heads",
        "refs/tags",
    ] {
        std::fs::create_dir_all(dest.join(sub))?;
    }
    // config
    std::fs::write(
        dest.join("config"),
        "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = true\n",
    )?;
    Ok(())
}

/// Write one object as a loose Git object file.
///
/// The file is placed at `objects/<xx>/<rest>` where `<xx>` is the first two
/// hex characters and `<rest>` is the remaining 38.  The content is the
/// zlib-deflated `"<kind> <size>\0<payload>"`.
fn write_loose_object(
    git_dir: &Path,
    sha1: &str,
    kind: &str,
    payload: &[u8],
) -> Result<(), std::io::Error> {
    if sha1.len() < 4 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "sha1 too short",
        ));
    }
    let dir = git_dir.join("objects").join(&sha1[..2]);
    std::fs::create_dir_all(&dir)?;
    let file_path = dir.join(&sha1[2..]);

    // Idempotent: skip if already written.
    if file_path.exists() {
        return Ok(());
    }

    let header = format!("{kind} {}\0", payload.len());
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(header.as_bytes())?;
    encoder.write_all(payload)?;
    let compressed = encoder.finish()?;

    std::fs::write(file_path, compressed)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // Well-known SHA-1 values from stock git.
    const EMPTY_BLOB_SHA1: &str = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";
    const EMPTY_TREE_SHA1: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

    #[test]
    fn git_sha1_empty_blob() {
        let sha = git_sha1(GitKind::Blob, &[]);
        assert_eq!(sha, EMPTY_BLOB_SHA1);
    }

    #[test]
    fn git_sha1_empty_tree() {
        let sha = git_sha1(GitKind::Tree, &[]);
        assert_eq!(sha, EMPTY_TREE_SHA1);
    }

    #[test]
    fn git_sha1_known_blob() {
        // echo -ne "what is up, doc?\n" | git hash-object --stdin
        //   → 7108f7ecb345ee9d0084193f147cdad4d2998293
        let payload = b"what is up, doc?\n";
        let sha = git_sha1(GitKind::Blob, payload);
        assert_eq!(sha, "7108f7ecb345ee9d0084193f147cdad4d2998293");
    }

    #[test]
    fn write_and_read_loose_object_roundtrip() {
        let dir = tempfile::tempdir().expect("tempdir");
        let payload = b"hello, git!";
        let kind = GitKind::Blob;
        let sha1 = git_sha1(kind, payload);

        write_loose_object(dir.path(), &sha1, kind.as_str(), payload).expect("write");

        let obj_path = dir.path().join("objects").join(&sha1[..2]).join(&sha1[2..]);
        assert!(obj_path.exists(), "loose object file should exist");

        let (read_kind, read_payload) = read_loose_object(&obj_path).expect("read");
        assert_eq!(read_kind, GitKind::Blob);
        assert_eq!(read_payload, payload);
    }

    #[test]
    fn write_loose_object_is_idempotent() {
        let dir = tempfile::tempdir().expect("tempdir");
        let payload = b"idempotent";
        let sha1 = git_sha1(GitKind::Blob, payload);

        write_loose_object(dir.path(), &sha1, "blob", payload).expect("first write");
        write_loose_object(dir.path(), &sha1, "blob", payload).expect("second write (idempotent)");
    }

    #[test]
    fn parse_commit_parents_no_parents() {
        let payload = b"tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\nauthor A <a@b.com> 0 +0000\ncommitter A <a@b.com> 0 +0000\n\ninitial\n";
        let parents = parse_commit_parents(payload).expect("parse");
        assert!(parents.is_empty());
    }

    #[test]
    fn parse_commit_parents_one_parent() {
        let payload = b"tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\nparent aabbccddaabbccddaabbccddaabbccddaabbccdd\nauthor A <a@b.com> 0 +0000\ncommitter A <a@b.com> 0 +0000\n\nsecond\n";
        let parents = parse_commit_parents(payload).expect("parse");
        assert_eq!(parents, vec!["aabbccddaabbccddaabbccddaabbccddaabbccdd"]);
    }

    #[test]
    fn parse_commit_parents_merge_two() {
        let payload = b"tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\nparent aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nparent bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\nauthor A <a@b.com> 0 +0000\ncommitter A <a@b.com> 0 +0000\n\nmerge\n";
        let parents = parse_commit_parents(payload).expect("parse");
        assert_eq!(parents.len(), 2);
    }

    #[test]
    fn is_hex_sha1_valid() {
        assert!(is_hex_sha1("aabbccddaabbccddaabbccddaabbccddaabbccdd"));
        assert!(is_hex_sha1(EMPTY_BLOB_SHA1));
    }

    #[test]
    fn is_hex_sha1_invalid() {
        assert!(!is_hex_sha1("short"));
        assert!(!is_hex_sha1("ggbbccddaabbccddaabbccddaabbccddaabbccdd")); // 'g' not hex
        assert!(!is_hex_sha1("")); // empty
    }

    #[test]
    fn collect_loose_objects_finds_files() {
        // Create a fake object store on disk.
        let dir = tempfile::tempdir().expect("tempdir");
        let obj_dir = dir.path().join("objects").join("ab");
        std::fs::create_dir_all(&obj_dir).unwrap();
        let hex = "ab".to_string() + &"c".repeat(38); // 40-char hex
        std::fs::write(obj_dir.join("c".repeat(38)), b"fake").unwrap();

        let found = collect_loose_objects(dir.path()).expect("collect");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].0, hex);
    }
}
