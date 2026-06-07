//! Working-tree primitives: walk a directory and snapshot every file as a
//! blob; recursively build a tree object representing the snapshot;
//! materialize a tree out to disk byte-for-byte.
//!
//! v1 ignores common build-output directories (`node_modules/`, `target/`,
//! `.git/`, `.sharp/`, `dist/`, `.cargo/`) on snapshot. The list is
//! hardcoded; project-level overrides are post-v1 and would slot in via a
//! `.sharpignore` file.
//!
//! Native Sharp objects are content-addressed by SHA-256 (see [`crate::object`]);
//! this module reuses that store rather than introducing a separate hash space.
//!
//! ## Object-id model (chosen: git-canonical header-prefixed)
//!
//! Every CAS object — blob, tree, commit — is keyed by the **git-canonical
//! header-prefixed** SHA-256: the digest of `"<kind> <size>\0<payload>"`, i.e.
//! `id_hex(hash_object(kind, payload, Sha256))`. This is the *only* id that
//! tree entries can reference, since [`encode_tree`] embeds exactly that id and
//! [`decode_tree`] hands it straight to `object::load`. It also matches the TS
//! source of truth: the server's `putObject` (`apps/server/src/cas.ts`) and the
//! client's `workspace.ts` both key on `hashObject(kind, payload, algo)`.
//!
//! The naive `object::store` keys on the SHA-256 of the *raw* payload (no
//! header), which is a different digest and would store blobs/trees under an id
//! tree entries never reference — the snapshot would store under one id and
//! materialize would look up under another. To stay consistent we route all
//! writes in this module through [`store_canonical`], which inserts under the
//! header-prefixed id. Both ids are SHA-256 (the `sharp.objects` key column is
//! unchanged), satisfying the "native sharp objects stay SHA-256" decision.
//!
//! Ported from `sharp/apps/client/src/workspace.ts`.

use std::collections::BTreeMap;
use std::path::Path;

use sqlx::PgPool;
use uuid::Uuid;

use crate::error::SharpError;
use crate::git_canonical::{
    decode_tree, encode_tree, id_from_hex, id_hex, HashAlgo, ObjectKind, TreeEntry, TreeMode,
};
use crate::object;

/// Native Sharp object ids are SHA-256.
const ALGO: HashAlgo = HashAlgo::Sha256;

// The canonical-id object store lives in [`object::store_canonical`] — the
// shared home for the git-canonical id model — so any future caller can reuse
// it. This module routes all working-tree object writes through it.

/// Directory names skipped while walking a working tree.
const IGNORED_DIRS: &[&str] = &[".git", ".sharp", "node_modules", "target", "dist", ".cargo"];

/// A single file (or symlink) captured by [`snapshot_working_tree`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileSnapshot {
    /// Relative path under the snapshot root (forward slashes, no leading slash).
    pub path: String,
    /// The git-canonical tree mode (regular/executable/symlink).
    pub mode: TreeMode,
    /// The SHA-256 hex digest of the stored blob.
    pub blob_sha: String,
}

/// Walk `root`, hash every file as a blob, store blobs in `sharp.objects`, and
/// return the snapshot sorted by path. The caller passes the resulting list to
/// [`build_tree_from_snapshot`] to construct the root tree object.
///
/// Symlinks are stored as blobs whose content is the (UTF-8) link target, with
/// mode `120000`. Regular files are stored verbatim; the executable bit (any of
/// the `0o111` owner/group/other exec bits) selects mode `100755` vs `100644`.
/// The directories in [`IGNORED_DIRS`] are skipped.
///
/// # Errors
///
/// Returns [`SharpError::Io`] on a filesystem error, or [`SharpError::Db`] when
/// a blob cannot be stored.
pub async fn snapshot_working_tree(
    pool: &PgPool,
    repo_id: Uuid,
    root: &Path,
) -> Result<Vec<FileSnapshot>, SharpError> {
    let mut out: Vec<FileSnapshot> = Vec::new();
    walk(pool, repo_id, root, root, &mut out).await?;
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

/// Recursive directory walk. Mirrors the TS `walk`: directories recurse,
/// symlinks store their target text, files store their content.
///
/// Boxed future because the recursion is across an `async fn` boundary.
fn walk<'a>(
    pool: &'a PgPool,
    repo_id: Uuid,
    root: &'a Path,
    dir: &'a Path,
    out: &'a mut Vec<FileSnapshot>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), SharpError>> + 'a>> {
    Box::pin(async move {
        // Collect names first so the iterator (and its dirent fd) is dropped
        // before we recurse / await.
        let mut names: Vec<std::ffi::OsString> = Vec::new();
        for entry in std::fs::read_dir(dir)? {
            names.push(entry?.file_name());
        }

        for name in names {
            if name.to_str().is_some_and(|n| IGNORED_DIRS.contains(&n)) {
                continue;
            }
            let full = dir.join(&name);
            // `symlink_metadata` does not follow symlinks (matches TS's
            // dirent.isSymbolicLink branch taking precedence over isFile).
            let meta = std::fs::symlink_metadata(&full)?;
            let file_type = meta.file_type();

            if file_type.is_symlink() {
                let target = std::fs::read_link(&full)?;
                let buf = target.to_string_lossy().into_owned().into_bytes();
                let sha = object::store_canonical(pool, repo_id, ObjectKind::Blob, &buf).await?;
                out.push(FileSnapshot {
                    path: rel_path(root, &full),
                    mode: TreeMode::Symlink,
                    blob_sha: sha,
                });
            } else if file_type.is_dir() {
                walk(pool, repo_id, root, &full, out).await?;
            } else if file_type.is_file() {
                let data = std::fs::read(&full)?;
                let sha = object::store_canonical(pool, repo_id, ObjectKind::Blob, &data).await?;
                let mode = if is_executable(&meta) {
                    TreeMode::Executable
                } else {
                    TreeMode::Regular
                };
                out.push(FileSnapshot {
                    path: rel_path(root, &full),
                    mode,
                    blob_sha: sha,
                });
            }
            // Other file types (sockets, fifos, …) are skipped, as in TS.
        }
        Ok(())
    })
}

/// Relative path under `root`, with forward slashes and no leading slash.
fn rel_path(root: &Path, full: &Path) -> String {
    let rel = full.strip_prefix(root).unwrap_or(full);
    let mut s = String::new();
    for (i, comp) in rel.components().enumerate() {
        if i > 0 {
            s.push('/');
        }
        s.push_str(&comp.as_os_str().to_string_lossy());
    }
    s
}

/// Whether a regular file's mode carries any execute bit (owner/group/other).
#[cfg(unix)]
fn is_executable(meta: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;
    meta.mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn is_executable(_meta: &std::fs::Metadata) -> bool {
    false
}

/// Recursively build tree objects from a flat snapshot, storing each subtree in
/// `sharp.objects`. Returns the SHA-256 hex of the root tree.
///
/// Subtrees are grouped by path prefix and emitted bottom-up; each subtree is
/// encoded via [`crate::git_canonical`] (SHA-256) and stored in the CAS.
///
/// # Errors
///
/// Returns [`SharpError::Db`] when a tree object cannot be stored, or a wrapped
/// git-canonical encode error (as [`SharpError::GitInterop`]).
pub async fn build_tree_from_snapshot(
    pool: &PgPool,
    repo_id: Uuid,
    files: &[FileSnapshot],
) -> Result<String, SharpError> {
    build_subtree(pool, repo_id, files, "").await
}

/// Build the subtree rooted at `prefix` (no trailing slash; "" for the root),
/// store it, and return its SHA-256 hex.
fn build_subtree<'a>(
    pool: &'a PgPool,
    repo_id: Uuid,
    files: &'a [FileSnapshot],
    prefix: &'a str,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, SharpError>> + 'a>> {
    Box::pin(async move {
        // Partition `files` by the segment immediately after `prefix`:
        //   - file directly under prefix → leaf entry (blob/symlink)
        //   - file deeper under prefix   → recurse into child subtree by name
        let mut child_entries: Vec<TreeEntry> = Vec::new();
        // BTreeMap keeps deterministic child ordering; encode_tree re-sorts to
        // git's canonical order regardless.
        let mut sub_paths: BTreeMap<String, Vec<FileSnapshot>> = BTreeMap::new();

        for f in files {
            let tail: &str = if prefix.is_empty() {
                &f.path
            } else {
                // prefix + '/' is guaranteed to be a prefix of f.path here.
                &f.path[prefix.len() + 1..]
            };
            match tail.find('/') {
                None => {
                    let id = id_from_hex(&f.blob_sha)
                        .map_err(|e| SharpError::GitInterop(e.to_string()))?;
                    child_entries.push(TreeEntry {
                        mode: f.mode,
                        name: tail.to_string(),
                        id,
                    });
                }
                Some(slash) => {
                    let head = tail[..slash].to_string();
                    sub_paths.entry(head).or_default().push(f.clone());
                }
            }
        }

        // Build subtrees bottom-up.
        for (name, sub_files) in &sub_paths {
            let sub_prefix = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            let sub_tree_sha = build_subtree(pool, repo_id, sub_files, &sub_prefix).await?;
            let id =
                id_from_hex(&sub_tree_sha).map_err(|e| SharpError::GitInterop(e.to_string()))?;
            child_entries.push(TreeEntry {
                mode: TreeMode::Directory,
                name: name.clone(),
                id,
            });
        }

        let bytes =
            encode_tree(&child_entries, ALGO).map_err(|e| SharpError::GitInterop(e.to_string()))?;
        // Store under the git-canonical header-prefixed id — the exact id tree
        // entries reference and that `materialize_recursive` loads by. See the
        // module docs for the chosen id model.
        object::store_canonical(pool, repo_id, ObjectKind::Tree, &bytes).await
    })
}

// ---------------------------------------------------------------------------
// Materialization (the inverse direction)
// ---------------------------------------------------------------------------

/// Materialize a tree onto the filesystem at `dest`. Removes everything under
/// `dest` first (except `.sharp/` and `.git/`), so the working tree exactly
/// matches the tree's contents.
///
/// # Errors
///
/// Returns [`SharpError::Io`] on a filesystem error, [`SharpError::ObjectNotFound`]
/// when a referenced object is missing, or a wrapped decode error.
pub async fn materialize_tree(
    pool: &PgPool,
    root_tree_sha: &str,
    dest: &Path,
) -> Result<(), SharpError> {
    clear_working_tree(dest)?;
    materialize_recursive(pool, root_tree_sha, dest).await
}

/// Remove every top-level entry under `dest` except `.sharp/` and `.git/`.
/// A missing `dest` is treated as already-clear.
fn clear_working_tree(dest: &Path) -> Result<(), SharpError> {
    let read = match std::fs::read_dir(dest) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.into()),
    };
    for entry in read {
        let entry = entry?;
        let name = entry.file_name();
        if name == *".sharp" || name == *".git" {
            continue;
        }
        let path = entry.path();
        let meta = std::fs::symlink_metadata(&path)?;
        if meta.is_dir() {
            std::fs::remove_dir_all(&path)?;
        } else {
            std::fs::remove_file(&path)?;
        }
    }
    Ok(())
}

/// Recursively materialize the tree `tree_sha` into directory `dest`.
fn materialize_recursive<'a>(
    pool: &'a PgPool,
    tree_sha: &'a str,
    dest: &'a Path,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), SharpError>> + 'a>> {
    Box::pin(async move {
        let data = object::load(pool, tree_sha).await?;
        let entries = decode_tree(&data, ALGO).map_err(|e| SharpError::GitInterop(e.to_string()))?;
        std::fs::create_dir_all(dest)?;
        for entry in entries {
            let path = dest.join(&entry.name);
            let id_hex_str = id_hex(&entry.id);
            match entry.mode {
                TreeMode::Directory => {
                    materialize_recursive(pool, &id_hex_str, &path).await?;
                }
                TreeMode::Symlink => {
                    let blob = object::load(pool, &id_hex_str).await?;
                    if let Some(parent) = path.parent() {
                        std::fs::create_dir_all(parent)?;
                    }
                    let target = String::from_utf8_lossy(&blob).into_owned();
                    write_symlink(&target, &path)?;
                }
                TreeMode::Gitlink => {
                    // Submodule gitlink — preserve as an empty directory in v1;
                    // no recursive ingest. See whitepaper §7.1.
                    std::fs::create_dir_all(&path)?;
                }
                TreeMode::Regular | TreeMode::Executable => {
                    let blob = object::load(pool, &id_hex_str).await?;
                    if let Some(parent) = path.parent() {
                        std::fs::create_dir_all(parent)?;
                    }
                    std::fs::write(&path, &blob)?;
                    if entry.mode == TreeMode::Executable {
                        set_executable(&path)?;
                    }
                }
            }
        }
        Ok(())
    })
}

/// Create a symlink at `path` pointing to `target`.
#[cfg(unix)]
fn write_symlink(target: &str, path: &Path) -> Result<(), SharpError> {
    std::os::unix::fs::symlink(target, path)?;
    Ok(())
}

#[cfg(not(unix))]
fn write_symlink(target: &str, path: &Path) -> Result<(), SharpError> {
    // Best-effort on non-unix: write the link target as a plain file.
    std::fs::write(path, target.as_bytes())?;
    Ok(())
}

/// Set mode `0o755` on a materialized executable file.
#[cfg(unix)]
fn set_executable(path: &Path) -> Result<(), SharpError> {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = std::fs::metadata(path)?.permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(path, perms)?;
    Ok(())
}

#[cfg(not(unix))]
fn set_executable(_path: &Path) -> Result<(), SharpError> {
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests — filesystem-only round-trips. These must pass (not ignored).
// The DB-backed snapshot/materialize paths are covered by #[ignore]'d tests.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rel_path_uses_forward_slashes() {
        let root = Path::new("/tmp/root");
        let full = Path::new("/tmp/root/a/b/c.txt");
        assert_eq!(rel_path(root, full), "a/b/c.txt");
    }

    #[test]
    fn rel_path_top_level() {
        let root = Path::new("/tmp/root");
        let full = Path::new("/tmp/root/file");
        assert_eq!(rel_path(root, full), "file");
    }

    #[cfg(unix)]
    #[test]
    fn is_executable_detects_exec_bit() {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let plain = dir.path().join("plain");
        let exec = dir.path().join("exec");
        std::fs::File::create(&plain).unwrap().write_all(b"x").unwrap();
        std::fs::File::create(&exec).unwrap().write_all(b"x").unwrap();
        let mut p = std::fs::metadata(&exec).unwrap().permissions();
        p.set_mode(0o755);
        std::fs::set_permissions(&exec, p).unwrap();
        assert!(!is_executable(&std::fs::symlink_metadata(&plain).unwrap()));
        assert!(is_executable(&std::fs::symlink_metadata(&exec).unwrap()));
    }

    /// In-memory CAS mirroring the real store's id model: every object is
    /// keyed by its **git-canonical header-prefixed** SHA-256 id — the same id
    /// tree entries reference. (The previous version keyed blobs by raw-bytes
    /// SHA-256 and re-stored trees under both ids to paper over the mismatch;
    /// now there is a single id space, matching `store_canonical`.)
    use crate::git_canonical::hash_object;
    use std::cell::RefCell;
    use std::collections::HashMap;

    #[derive(Default)]
    struct MemCas {
        objects: RefCell<HashMap<String, Vec<u8>>>,
    }

    impl MemCas {
        /// Store under the git-canonical id for `kind` and return it.
        fn store(&self, kind: ObjectKind, data: &[u8]) -> String {
            let id = id_hex(&hash_object(kind, data, ALGO));
            self.objects.borrow_mut().insert(id.clone(), data.to_vec());
            id
        }
        fn load(&self, id: &str) -> Vec<u8> {
            self.objects.borrow().get(id).cloned().unwrap()
        }
    }

    // Mirror of build_subtree, but against MemCas — keeps the test purely
    // filesystem/memory and verifies the partition + canonical-encode logic.
    fn build_subtree_mem(cas: &MemCas, files: &[FileSnapshot], prefix: &str) -> String {
        let mut child_entries: Vec<TreeEntry> = Vec::new();
        let mut sub_paths: BTreeMap<String, Vec<FileSnapshot>> = BTreeMap::new();
        for f in files {
            let tail: &str = if prefix.is_empty() {
                &f.path
            } else {
                &f.path[prefix.len() + 1..]
            };
            match tail.find('/') {
                None => child_entries.push(TreeEntry {
                    mode: f.mode,
                    name: tail.to_string(),
                    id: id_from_hex(&f.blob_sha).unwrap(),
                }),
                Some(slash) => sub_paths
                    .entry(tail[..slash].to_string())
                    .or_default()
                    .push(f.clone()),
            }
        }
        for (name, sub_files) in &sub_paths {
            let sub_prefix = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            let sub_sha = build_subtree_mem(cas, sub_files, &sub_prefix);
            child_entries.push(TreeEntry {
                mode: TreeMode::Directory,
                name: name.clone(),
                id: id_from_hex(&sub_sha).unwrap(),
            });
        }
        let bytes = encode_tree(&child_entries, ALGO).unwrap();
        // Single id space: store the tree under its git-canonical id, which is
        // exactly what parent entries reference and what materialize loads by.
        cas.store(ObjectKind::Tree, &bytes)
    }

    fn materialize_mem(cas: &MemCas, tree_sha: &str, dest: &Path) {
        let data = cas.load(tree_sha);
        let entries = decode_tree(&data, ALGO).unwrap();
        std::fs::create_dir_all(dest).unwrap();
        for entry in entries {
            let path = dest.join(&entry.name);
            let id_hex_str = id_hex(&entry.id);
            match entry.mode {
                TreeMode::Directory => materialize_mem(cas, &id_hex_str, &path),
                TreeMode::Symlink => {
                    let blob = cas.load(&id_hex_str);
                    write_symlink(&String::from_utf8_lossy(&blob), &path).unwrap();
                }
                TreeMode::Gitlink => std::fs::create_dir_all(&path).unwrap(),
                TreeMode::Regular | TreeMode::Executable => {
                    let blob = cas.load(&id_hex_str);
                    if let Some(parent) = path.parent() {
                        std::fs::create_dir_all(parent).unwrap();
                    }
                    std::fs::write(&path, &blob).unwrap();
                    if entry.mode == TreeMode::Executable {
                        set_executable(&path).unwrap();
                    }
                }
            }
        }
    }

    /// Walk a directory into a snapshot using MemCas (no DB). Mirrors `walk`.
    fn snapshot_mem(cas: &MemCas, root: &Path) -> Vec<FileSnapshot> {
        fn walk(cas: &MemCas, root: &Path, dir: &Path, out: &mut Vec<FileSnapshot>) {
            let mut names: Vec<std::ffi::OsString> = std::fs::read_dir(dir)
                .unwrap()
                .map(|e| e.unwrap().file_name())
                .collect();
            names.sort();
            for name in names {
                if name.to_str().is_some_and(|n| IGNORED_DIRS.contains(&n)) {
                    continue;
                }
                let full = dir.join(&name);
                let meta = std::fs::symlink_metadata(&full).unwrap();
                let ft = meta.file_type();
                if ft.is_symlink() {
                    let target = std::fs::read_link(&full).unwrap();
                    let sha = cas.store(ObjectKind::Blob, target.to_string_lossy().as_bytes());
                    out.push(FileSnapshot {
                        path: rel_path(root, &full),
                        mode: TreeMode::Symlink,
                        blob_sha: sha,
                    });
                } else if ft.is_dir() {
                    walk(cas, root, &full, out);
                } else if ft.is_file() {
                    let data = std::fs::read(&full).unwrap();
                    let sha = cas.store(ObjectKind::Blob, &data);
                    let mode = if is_executable(&meta) {
                        TreeMode::Executable
                    } else {
                        TreeMode::Regular
                    };
                    out.push(FileSnapshot {
                        path: rel_path(root, &full),
                        mode,
                        blob_sha: sha,
                    });
                }
            }
        }
        let mut out = Vec::new();
        walk(cas, root, root, &mut out);
        out.sort_by(|a, b| a.path.cmp(&b.path));
        out
    }

    #[test]
    fn snapshot_build_materialize_round_trips_file_contents() {
        use std::io::Write;
        let src = tempfile::tempdir().unwrap();
        // Nested layout: a/b.txt, a/c/d.txt, top.txt
        std::fs::create_dir_all(src.path().join("a/c")).unwrap();
        std::fs::File::create(src.path().join("top.txt"))
            .unwrap()
            .write_all(b"top level")
            .unwrap();
        std::fs::File::create(src.path().join("a/b.txt"))
            .unwrap()
            .write_all(b"hello b")
            .unwrap();
        std::fs::File::create(src.path().join("a/c/d.txt"))
            .unwrap()
            .write_all(b"deep d")
            .unwrap();

        let cas = MemCas::default();
        let snap = snapshot_mem(&cas, src.path());
        assert_eq!(
            snap.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(),
            vec!["a/b.txt", "a/c/d.txt", "top.txt"]
        );

        let root_tree = build_subtree_mem(&cas, &snap, "");

        let dest = tempfile::tempdir().unwrap();
        materialize_mem(&cas, &root_tree, dest.path());

        assert_eq!(
            std::fs::read(dest.path().join("top.txt")).unwrap(),
            b"top level"
        );
        assert_eq!(
            std::fs::read(dest.path().join("a/b.txt")).unwrap(),
            b"hello b"
        );
        assert_eq!(
            std::fs::read(dest.path().join("a/c/d.txt")).unwrap(),
            b"deep d"
        );
    }

    #[cfg(unix)]
    #[test]
    fn round_trip_preserves_exec_bit() {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;
        let src = tempfile::tempdir().unwrap();
        let script = src.path().join("run.sh");
        std::fs::File::create(&script)
            .unwrap()
            .write_all(b"#!/bin/sh\necho hi\n")
            .unwrap();
        let mut p = std::fs::metadata(&script).unwrap().permissions();
        p.set_mode(0o755);
        std::fs::set_permissions(&script, p).unwrap();

        let cas = MemCas::default();
        let snap = snapshot_mem(&cas, src.path());
        assert_eq!(snap.len(), 1);
        assert_eq!(snap[0].mode, TreeMode::Executable);

        let root_tree = build_subtree_mem(&cas, &snap, "");
        let dest = tempfile::tempdir().unwrap();
        materialize_mem(&cas, &root_tree, dest.path());

        let out_mode = std::fs::metadata(dest.path().join("run.sh"))
            .unwrap()
            .permissions()
            .mode();
        assert_ne!(out_mode & 0o111, 0, "exec bit should survive round-trip");
    }

    #[cfg(unix)]
    #[test]
    fn round_trip_preserves_symlink() {
        use std::io::Write;
        let src = tempfile::tempdir().unwrap();
        std::fs::File::create(src.path().join("target.txt"))
            .unwrap()
            .write_all(b"linked content")
            .unwrap();
        std::os::unix::fs::symlink("target.txt", src.path().join("link")).unwrap();

        let cas = MemCas::default();
        let snap = snapshot_mem(&cas, src.path());
        let link = snap.iter().find(|f| f.path == "link").unwrap();
        assert_eq!(link.mode, TreeMode::Symlink);

        let root_tree = build_subtree_mem(&cas, &snap, "");
        let dest = tempfile::tempdir().unwrap();
        materialize_mem(&cas, &root_tree, dest.path());

        let link_path = dest.path().join("link");
        let meta = std::fs::symlink_metadata(&link_path).unwrap();
        assert!(meta.file_type().is_symlink());
        assert_eq!(std::fs::read_link(&link_path).unwrap().to_str().unwrap(), "target.txt");
    }

    #[test]
    fn snapshot_skips_ignored_dirs() {
        use std::io::Write;
        let src = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(src.path().join("target")).unwrap();
        std::fs::create_dir_all(src.path().join("node_modules")).unwrap();
        std::fs::File::create(src.path().join("target/junk"))
            .unwrap()
            .write_all(b"junk")
            .unwrap();
        std::fs::File::create(src.path().join("keep.txt"))
            .unwrap()
            .write_all(b"keep")
            .unwrap();

        let cas = MemCas::default();
        let snap = snapshot_mem(&cas, src.path());
        assert_eq!(
            snap.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(),
            vec!["keep.txt"]
        );
    }

    #[test]
    fn empty_dir_snapshots_to_empty_tree() {
        let src = tempfile::tempdir().unwrap();
        let cas = MemCas::default();
        let snap = snapshot_mem(&cas, src.path());
        assert!(snap.is_empty());
        let root_tree = build_subtree_mem(&cas, &snap, "");
        // Empty tree encodes to zero bytes; materialize should produce a dir.
        let dest = tempfile::tempdir().unwrap();
        materialize_mem(&cas, &root_tree, dest.path());
        assert_eq!(std::fs::read_dir(dest.path()).unwrap().count(), 0);
    }

    // -----------------------------------------------------------------------
    // DB-gated round-trip: snapshot → build → materialize is identity.
    //
    // Proves the real (Postgres-backed) paths agree on a single object-id
    // space — the bug being fixed was that blobs/trees were *stored* under the
    // raw-bytes SHA-256 but tree entries *referenced* the git-canonical
    // header-prefixed id, so materialize looked objects up under an id nothing
    // was stored at. `#[ignore]`'d because it needs a live DB + migrations.
    // Run with: DATABASE_URL=… cargo test -p sharp -- --include-ignored db_round_trip
    // -----------------------------------------------------------------------

    async fn connect_pool() -> PgPool {
        let url = std::env::var("DATABASE_URL").expect("DATABASE_URL must be set");
        sqlx::postgres::PgPoolOptions::new()
            .max_connections(5)
            .connect(&url)
            .await
            .expect("connect to DATABASE_URL")
    }

    #[cfg(unix)]
    #[tokio::test]
    #[ignore = "integration: requires DATABASE_URL and applied Sharp migrations"]
    async fn db_round_trip_snapshot_build_materialize_is_identity() {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;

        let pool = connect_pool().await;
        let repo_name = format!(
            "ws-round-trip-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let repo = crate::repo::init(&pool, &repo_name)
            .await
            .expect("repo init");

        // Source tree: nested dirs, a top-level file, an executable, a symlink.
        let src = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(src.path().join("a/c")).unwrap();
        std::fs::File::create(src.path().join("top.txt"))
            .unwrap()
            .write_all(b"top level")
            .unwrap();
        std::fs::File::create(src.path().join("a/b.txt"))
            .unwrap()
            .write_all(b"hello b")
            .unwrap();
        std::fs::File::create(src.path().join("a/c/d.txt"))
            .unwrap()
            .write_all(b"deep d")
            .unwrap();
        let script = src.path().join("a/run.sh");
        std::fs::File::create(&script)
            .unwrap()
            .write_all(b"#!/bin/sh\necho hi\n")
            .unwrap();
        let mut perms = std::fs::metadata(&script).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script, perms).unwrap();
        std::os::unix::fs::symlink("top.txt", src.path().join("link")).unwrap();

        // snapshot → build (the forward direction).
        let snap = snapshot_working_tree(&pool, repo.id, src.path())
            .await
            .expect("snapshot");
        let root_tree = build_tree_from_snapshot(&pool, repo.id, &snap)
            .await
            .expect("build tree");

        // materialize (the inverse) into a fresh dir. The fix means every id a
        // tree entry references resolves; pre-fix this would ObjectNotFound.
        let dest = tempfile::tempdir().unwrap();
        materialize_tree(&pool, &root_tree, dest.path())
            .await
            .expect("materialize");

        // Identity: contents, exec bit, and symlink survive.
        assert_eq!(
            std::fs::read(dest.path().join("top.txt")).unwrap(),
            b"top level"
        );
        assert_eq!(std::fs::read(dest.path().join("a/b.txt")).unwrap(), b"hello b");
        assert_eq!(
            std::fs::read(dest.path().join("a/c/d.txt")).unwrap(),
            b"deep d"
        );
        let out_mode = std::fs::metadata(dest.path().join("a/run.sh"))
            .unwrap()
            .permissions()
            .mode();
        assert_ne!(out_mode & 0o111, 0, "exec bit should survive round-trip");
        let link_meta = std::fs::symlink_metadata(dest.path().join("link")).unwrap();
        assert!(link_meta.file_type().is_symlink());
        assert_eq!(
            std::fs::read_link(dest.path().join("link"))
                .unwrap()
                .to_str()
                .unwrap(),
            "top.txt"
        );

        // Re-snapshotting the materialized tree yields the same root id — the
        // strongest identity statement (same id space end-to-end).
        let snap2 = snapshot_working_tree(&pool, repo.id, dest.path())
            .await
            .expect("re-snapshot");
        let root_tree2 = build_tree_from_snapshot(&pool, repo.id, &snap2)
            .await
            .expect("re-build tree");
        assert_eq!(root_tree, root_tree2, "round-trip must reproduce root tree id");
    }
}
