//! Git-canonical object encoding and decoding.
//!
//! Sharp stores object payloads in their *inflated* canonical form — the bytes
//! Git would compute its content-addressed hash over. This module owns the
//! encoding rules so server CAS, client commit-builder, and Git import/export
//! all share one source of truth.
//!
//! The canonical form Sharp hashes is:
//!   `<kind> <decimal-size>\0<payload>`
//!
//! Where `<payload>` is one of:
//!   - blob:    file contents verbatim
//!   - tree:    sorted entry list, each `<mode> <name>\0<id-binary>`
//!   - commit:  header lines + blank + message
//!   - tag:     header lines + blank + message
//!
//! Tree-entry sort is the famous "directory-sort" quirk: entries are sorted
//! bytewise *as if every directory entry had a trailing `/`*, so `foo` (a
//! directory) sorts after `foo.txt` (a file). Tests cover this.
//!
//! Ported from `sharp/packages/git-canonical/src/index.ts`.

use sha1::Sha1;
use sha2::{Digest as _, Sha256};
use thiserror::Error;

/// Git object kinds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ObjectKind {
    Blob,
    Tree,
    Commit,
    Tag,
}

impl ObjectKind {
    /// The ASCII keyword Git uses for this kind.
    pub fn as_str(self) -> &'static str {
        match self {
            ObjectKind::Blob => "blob",
            ObjectKind::Tree => "tree",
            ObjectKind::Commit => "commit",
            ObjectKind::Tag => "tag",
        }
    }

    /// Parse a Git kind keyword.
    #[allow(clippy::should_implement_trait)] // returns Option, not a FromStr impl
    pub fn from_str(s: &str) -> Option<ObjectKind> {
        match s {
            "blob" => Some(ObjectKind::Blob),
            "tree" => Some(ObjectKind::Tree),
            "commit" => Some(ObjectKind::Commit),
            "tag" => Some(ObjectKind::Tag),
            _ => None,
        }
    }
}

/// Hash algorithm for Git object IDs. Sharp supports both for Git interop;
/// native sharp objects use SHA-256.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HashAlgo {
    Sha1,
    Sha256,
}

impl HashAlgo {
    /// Length in bytes of an object id under this algorithm.
    pub fn hash_len(self) -> usize {
        match self {
            HashAlgo::Sha1 => 20,
            HashAlgo::Sha256 => 32,
        }
    }
}

/// Errors raised while encoding or decoding git-canonical objects.
#[derive(Debug, Error)]
pub enum GitCanonicalError {
    #[error("invalid tree-entry mode: {0}")]
    InvalidTreeMode(String),
    #[error("tree-entry id length {got} does not match algo (expected {expected})")]
    IdLengthMismatch { got: usize, expected: usize },
    #[error("invalid tree-entry name: {0:?}")]
    InvalidTreeName(String),
    #[error("commit/tag {field} id length mismatch")]
    ObjectIdLengthMismatch { field: &'static str },
    #[error("decode error: {0}")]
    Decode(String),
    #[error("invalid hex: {0}")]
    Hex(String),
}

type Result<T> = std::result::Result<T, GitCanonicalError>;

// ---------------------------------------------------------------------------
// Hash
// ---------------------------------------------------------------------------

/// Compute the Git object ID for canonical-form bytes.
///
/// Git hashes `"<kind> <decimal-size>\0<payload>"`.
pub fn hash_object(kind: ObjectKind, payload: &[u8], algo: HashAlgo) -> Vec<u8> {
    let header = format!("{} {}\0", kind.as_str(), payload.len());
    match algo {
        HashAlgo::Sha1 => {
            use sha1::Digest as _;
            let mut h = Sha1::new();
            h.update(header.as_bytes());
            h.update(payload);
            h.finalize().to_vec()
        }
        HashAlgo::Sha256 => {
            let mut h = Sha256::new();
            h.update(header.as_bytes());
            h.update(payload);
            h.finalize().to_vec()
        }
    }
}

/// Lowercase hex of an object id.
pub fn id_hex(id: &[u8]) -> String {
    hex::encode(id)
}

/// Parse a hex object id into raw bytes.
pub fn id_from_hex(s: &str) -> Result<Vec<u8>> {
    hex::decode(s).map_err(|e| GitCanonicalError::Hex(e.to_string()))
}

/// Constant-shape byte equality for two object ids.
pub fn id_equal(a: &[u8], b: &[u8]) -> bool {
    a == b
}

// ---------------------------------------------------------------------------
// Tree entries
// ---------------------------------------------------------------------------

/// Git tree-entry modes. Stored as the exact ASCII strings Git uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TreeMode {
    /// 100644 — regular file.
    Regular,
    /// 100755 — executable file.
    Executable,
    /// 120000 — symlink.
    Symlink,
    /// 160000 — gitlink (submodule).
    Gitlink,
    /// 40000 — directory (NB: NO leading zero — see Git's tree.c).
    Directory,
}

impl TreeMode {
    /// The exact ASCII mode string Git writes.
    pub fn as_str(self) -> &'static str {
        match self {
            TreeMode::Regular => "100644",
            TreeMode::Executable => "100755",
            TreeMode::Symlink => "120000",
            TreeMode::Gitlink => "160000",
            TreeMode::Directory => "40000",
        }
    }

    /// Parse a Git tree-entry mode string.
    #[allow(clippy::should_implement_trait)] // returns Option, not a FromStr impl
    pub fn from_str(s: &str) -> Option<TreeMode> {
        match s {
            "100644" => Some(TreeMode::Regular),
            "100755" => Some(TreeMode::Executable),
            "120000" => Some(TreeMode::Symlink),
            "160000" => Some(TreeMode::Gitlink),
            "40000" => Some(TreeMode::Directory),
            _ => None,
        }
    }

    /// Whether this entry sorts as a directory (trailing `/` appended).
    ///
    /// Matches the TS source: only mode `40000` is treated as dir-like.
    fn is_dir_like(self) -> bool {
        matches!(self, TreeMode::Directory)
    }
}

/// A single tree entry: mode, name, and raw (binary) object id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TreeEntry {
    pub mode: TreeMode,
    pub name: String,
    pub id: Vec<u8>,
}

/// The name used for sorting: directory-like entries sort as if their name had
/// a trailing `/`. This is what causes `foo` (dir) to sort after `foo.txt`.
fn entry_sort_name(entry: &TreeEntry) -> Vec<u8> {
    let mut bytes = entry.name.as_bytes().to_vec();
    if entry.mode.is_dir_like() {
        bytes.push(b'/');
    }
    bytes
}

/// Compare two entries per Git's tree-sort rule (bytewise, with the dir quirk).
fn compare_tree_entries(a: &TreeEntry, b: &TreeEntry) -> std::cmp::Ordering {
    entry_sort_name(a).cmp(&entry_sort_name(b))
}

/// Encode a tree payload (sorted entry list, `<mode> <name>\0<id-binary>`).
pub fn encode_tree(entries: &[TreeEntry], algo: HashAlgo) -> Result<Vec<u8>> {
    let mut sorted: Vec<&TreeEntry> = entries.iter().collect();
    sorted.sort_by(|a, b| compare_tree_entries(a, b));
    let hash_len = algo.hash_len();

    // Validate first (TS validates inside the sizing loop, before writing).
    for e in &sorted {
        if e.id.len() != hash_len {
            return Err(GitCanonicalError::IdLengthMismatch {
                got: e.id.len(),
                expected: hash_len,
            });
        }
        if e.name.contains('\0') || e.name.contains('/') {
            return Err(GitCanonicalError::InvalidTreeName(e.name.clone()));
        }
    }

    let mut out = Vec::new();
    for e in &sorted {
        out.extend_from_slice(e.mode.as_str().as_bytes());
        out.push(b' ');
        out.extend_from_slice(e.name.as_bytes());
        out.push(0);
        out.extend_from_slice(&e.id);
    }
    Ok(out)
}

/// Decode a tree payload into its entries.
pub fn decode_tree(payload: &[u8], algo: HashAlgo) -> Result<Vec<TreeEntry>> {
    let hash_len = algo.hash_len();
    let mut out = Vec::new();
    let mut off = 0usize;
    while off < payload.len() {
        let nul = payload[off..]
            .iter()
            .position(|&b| b == 0)
            .map(|p| off + p)
            .ok_or_else(|| {
                GitCanonicalError::Decode("decodeTree: missing null terminator".into())
            })?;
        let header = std::str::from_utf8(&payload[off..nul])
            .map_err(|e| GitCanonicalError::Decode(format!("decodeTree: non-UTF-8 header: {e}")))?;
        let space = header.find(' ').ok_or_else(|| {
            GitCanonicalError::Decode("decodeTree: missing space in header".into())
        })?;
        let mode_str = &header[..space];
        let mode = TreeMode::from_str(mode_str).ok_or_else(|| {
            GitCanonicalError::Decode(format!("decodeTree: invalid mode {mode_str}"))
        })?;
        let name = header[space + 1..].to_string();
        if nul + 1 + hash_len > payload.len() {
            return Err(GitCanonicalError::Decode("decodeTree: truncated id".into()));
        }
        let id = payload[nul + 1..nul + 1 + hash_len].to_vec();
        out.push(TreeEntry { mode, name, id });
        off = nul + 1 + hash_len;
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

/// A commit author/committer/tagger identity with timestamp and timezone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitPerson {
    /// "Name <email>" without the timestamp/timezone.
    pub name_and_email: String,
    /// Unix epoch seconds.
    pub timestamp: i64,
    /// ±HHMM, e.g. "-0500", "+0000".
    pub timezone: String,
}

/// A header preserved verbatim (gpgsig, mergetag, encoding, …).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtraHeader {
    pub name: String,
    pub value: String,
}

/// A decoded/decodable Git commit object.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitObject {
    pub tree: Vec<u8>,
    pub parents: Vec<Vec<u8>>,
    pub author: CommitPerson,
    pub committer: CommitPerson,
    /// Optional headers preserved verbatim (gpgsig, mergetag, encoding, …).
    pub extra_headers: Vec<ExtraHeader>,
    pub message: String,
}

fn encode_person(p: &CommitPerson) -> String {
    format!("{} {} {}", p.name_and_email, p.timestamp, p.timezone)
}

/// Parse `"Name <email> <unix-ts> <tz>"`: the last two whitespace-separated
/// tokens are timestamp and timezone; everything else is the name+email.
fn parse_person(s: &str) -> CommitPerson {
    let last_sp = s.rfind(' ');
    match last_sp {
        None => CommitPerson {
            name_and_email: s.to_string(),
            timestamp: 0,
            timezone: String::new(),
        },
        Some(last_sp) => {
            let tz = s[last_sp + 1..].to_string();
            let ts_and_rest = &s[..last_sp];
            match ts_and_rest.rfind(' ') {
                None => CommitPerson {
                    name_and_email: String::new(),
                    timestamp: ts_and_rest.parse().unwrap_or(0),
                    timezone: tz,
                },
                Some(ts_sp) => {
                    let ts = ts_and_rest[ts_sp + 1..].parse().unwrap_or(0);
                    let name_and_email = ts_and_rest[..ts_sp].to_string();
                    CommitPerson {
                        name_and_email,
                        timestamp: ts,
                        timezone: tz,
                    }
                }
            }
        }
    }
}

/// Fold a multi-line header value per Git's rules: continuation lines are
/// prefixed with a single space.
fn fold_header_value(value: &str) -> String {
    value.replace('\n', "\n ")
}

fn unfold_header_value(value: &str) -> String {
    value.replace("\n ", "\n")
}

/// Encode a commit object into its canonical payload.
pub fn encode_commit(c: &CommitObject, algo: HashAlgo) -> Result<Vec<u8>> {
    let hash_len = algo.hash_len();
    if c.tree.len() != hash_len {
        return Err(GitCanonicalError::ObjectIdLengthMismatch { field: "tree" });
    }
    for p in &c.parents {
        if p.len() != hash_len {
            return Err(GitCanonicalError::ObjectIdLengthMismatch { field: "parent" });
        }
    }
    let mut lines: Vec<String> = Vec::new();
    lines.push(format!("tree {}", id_hex(&c.tree)));
    for p in &c.parents {
        lines.push(format!("parent {}", id_hex(p)));
    }
    lines.push(format!("author {}", encode_person(&c.author)));
    lines.push(format!("committer {}", encode_person(&c.committer)));
    for h in &c.extra_headers {
        lines.push(format!("{} {}", h.name, fold_header_value(&h.value)));
    }
    lines.push(String::new()); // blank line separating headers from message
    let mut text = lines.join("\n");
    text.push('\n');
    text.push_str(&c.message);
    Ok(text.into_bytes())
}

/// Decode a commit payload into a [`CommitObject`].
pub fn decode_commit(payload: &[u8]) -> Result<CommitObject> {
    let text = std::str::from_utf8(payload)
        .map_err(|e| GitCanonicalError::Decode(format!("decodeCommit: non-UTF-8: {e}")))?;
    let idx = text.find("\n\n").ok_or_else(|| {
        GitCanonicalError::Decode("decodeCommit: missing blank-line separator".into())
    })?;
    let header_block = &text[..idx];
    let message = text[idx + 2..].to_string();

    let mut headers: Vec<ExtraHeader> = Vec::new();
    let mut cur: Option<ExtraHeader> = None;
    for line in header_block.split('\n') {
        if let Some(rest) = line.strip_prefix(' ') {
            // continuation
            let c = cur.as_mut().ok_or_else(|| {
                GitCanonicalError::Decode(
                    "decodeCommit: continuation line without preceding header".into(),
                )
            })?;
            c.value.push('\n');
            c.value.push_str(rest);
        } else {
            if let Some(c) = cur.take() {
                headers.push(c);
            }
            let sp = line.find(' ').ok_or_else(|| {
                GitCanonicalError::Decode(format!("decodeCommit: malformed header: {line:?}"))
            })?;
            cur = Some(ExtraHeader {
                name: line[..sp].to_string(),
                value: line[sp + 1..].to_string(),
            });
        }
    }
    if let Some(c) = cur.take() {
        headers.push(c);
    }

    let mut tree: Option<Vec<u8>> = None;
    let mut parents: Vec<Vec<u8>> = Vec::new();
    let mut author: Option<CommitPerson> = None;
    let mut committer: Option<CommitPerson> = None;
    let mut extra_headers: Vec<ExtraHeader> = Vec::new();
    for h in headers {
        match h.name.as_str() {
            "tree" => tree = Some(id_from_hex(&h.value)?),
            "parent" => parents.push(id_from_hex(&h.value)?),
            "author" => author = Some(parse_person(&h.value)),
            "committer" => committer = Some(parse_person(&h.value)),
            _ => extra_headers.push(ExtraHeader {
                name: h.name,
                value: unfold_header_value(&h.value),
            }),
        }
    }
    let tree =
        tree.ok_or_else(|| GitCanonicalError::Decode("decodeCommit: missing tree header".into()))?;
    let author = author
        .ok_or_else(|| GitCanonicalError::Decode("decodeCommit: missing author header".into()))?;
    let committer = committer.ok_or_else(|| {
        GitCanonicalError::Decode("decodeCommit: missing committer header".into())
    })?;
    Ok(CommitObject {
        tree,
        parents,
        author,
        committer,
        extra_headers,
        message,
    })
}

// ---------------------------------------------------------------------------
// Tag (annotated)
// ---------------------------------------------------------------------------

/// A decoded/decodable annotated tag object.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TagObject {
    pub object: Vec<u8>,
    pub kind: ObjectKind,
    pub tag: String,
    pub tagger: Option<CommitPerson>,
    pub message: String,
}

/// Encode an annotated tag into its canonical payload.
pub fn encode_tag(t: &TagObject, algo: HashAlgo) -> Result<Vec<u8>> {
    if t.object.len() != algo.hash_len() {
        return Err(GitCanonicalError::ObjectIdLengthMismatch { field: "object" });
    }
    let mut lines: Vec<String> = Vec::new();
    lines.push(format!("object {}", id_hex(&t.object)));
    lines.push(format!("type {}", t.kind.as_str()));
    lines.push(format!("tag {}", t.tag));
    if let Some(tagger) = &t.tagger {
        lines.push(format!("tagger {}", encode_person(tagger)));
    }
    lines.push(String::new());
    let mut text = lines.join("\n");
    text.push('\n');
    text.push_str(&t.message);
    Ok(text.into_bytes())
}

/// Decode an annotated tag payload into a [`TagObject`].
pub fn decode_tag(payload: &[u8]) -> Result<TagObject> {
    let text = std::str::from_utf8(payload)
        .map_err(|e| GitCanonicalError::Decode(format!("decodeTag: non-UTF-8: {e}")))?;
    let idx = text.find("\n\n").ok_or_else(|| {
        GitCanonicalError::Decode("decodeTag: missing blank-line separator".into())
    })?;
    let header_block = &text[..idx];
    let message = text[idx + 2..].to_string();

    let mut object: Option<Vec<u8>> = None;
    let mut kind: Option<ObjectKind> = None;
    let mut tag: Option<String> = None;
    let mut tagger: Option<CommitPerson> = None;
    for line in header_block.split('\n') {
        let sp = line
            .find(' ')
            .ok_or_else(|| GitCanonicalError::Decode("decodeTag: malformed header".into()))?;
        let k = &line[..sp];
        let v = &line[sp + 1..];
        match k {
            "object" => object = Some(id_from_hex(v)?),
            "type" => kind = ObjectKind::from_str(v),
            "tag" => tag = Some(v.to_string()),
            "tagger" => tagger = Some(parse_person(v)),
            _ => {}
        }
    }
    let object = object
        .ok_or_else(|| GitCanonicalError::Decode("decodeTag: missing required header".into()))?;
    let kind =
        kind.ok_or_else(|| GitCanonicalError::Decode("decodeTag: missing required header".into()))?;
    let tag =
        tag.ok_or_else(|| GitCanonicalError::Decode("decodeTag: missing required header".into()))?;
    Ok(TagObject {
        object,
        kind,
        tag,
        tagger,
        message,
    })
}

// ---------------------------------------------------------------------------
// Tests — ported from canonical.test.ts. These are pure and must pass.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn pinned_person() -> CommitPerson {
        CommitPerson {
            name_and_email: "Alice Doe <alice@example.com>".to_string(),
            timestamp: 1735689600,
            timezone: "+0000".to_string(),
        }
    }

    // --- hashObject ---

    #[test]
    fn empty_tree_sha1() {
        let id = hash_object(ObjectKind::Tree, &[], HashAlgo::Sha1);
        assert_eq!(id_hex(&id), "4b825dc642cb6eb9a060e54bf8d69288fbee4904");
    }

    #[test]
    fn empty_blob_sha1() {
        let id = hash_object(ObjectKind::Blob, &[], HashAlgo::Sha1);
        assert_eq!(id_hex(&id), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    }

    #[test]
    fn what_is_up_doc_blob_sha1() {
        let id = hash_object(ObjectKind::Blob, b"what is up, doc?", HashAlgo::Sha1);
        assert_eq!(id_hex(&id), "bd9dbf5aae1a3862dd1526723246b20206e5fc37");
    }

    #[test]
    fn empty_tree_sha256() {
        let id = hash_object(ObjectKind::Tree, &[], HashAlgo::Sha256);
        assert_eq!(
            id_hex(&id),
            "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321"
        );
    }

    // --- encodeTree / decodeTree ---

    fn blob_entry(name: &str) -> TreeEntry {
        TreeEntry {
            mode: TreeMode::Regular,
            name: name.to_string(),
            id: hash_object(ObjectKind::Blob, &[], HashAlgo::Sha1),
        }
    }
    fn dir_entry(name: &str) -> TreeEntry {
        TreeEntry {
            mode: TreeMode::Directory,
            name: name.to_string(),
            id: hash_object(ObjectKind::Tree, &[], HashAlgo::Sha1),
        }
    }

    #[test]
    fn tree_roundtrips_single_entry() {
        let entries = vec![blob_entry("README.md")];
        let bytes = encode_tree(&entries, HashAlgo::Sha1).unwrap();
        let decoded = decode_tree(&bytes, HashAlgo::Sha1).unwrap();
        assert_eq!(decoded.len(), 1);
        assert_eq!(decoded[0].name, "README.md");
        assert_eq!(decoded[0].mode, TreeMode::Regular);
    }

    #[test]
    fn tree_directory_sort_quirk() {
        let entries = vec![dir_entry("foo"), blob_entry("foo.txt")];
        let bytes = encode_tree(&entries, HashAlgo::Sha1).unwrap();
        let decoded = decode_tree(&bytes, HashAlgo::Sha1).unwrap();
        let names: Vec<&str> = decoded.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["foo.txt", "foo"]);
    }

    #[test]
    fn tree_hashes_to_stock_git_sha1() {
        let entries = vec![blob_entry("hello.txt")];
        let tree_bytes = encode_tree(&entries, HashAlgo::Sha1).unwrap();
        let id = hash_object(ObjectKind::Tree, &tree_bytes, HashAlgo::Sha1);
        assert_eq!(id_hex(&id), "fcb545d5746547a597811b7441ed8eba307be1ff");
    }

    #[test]
    fn tree_supports_submodule_gitlinks() {
        let entries = vec![TreeEntry {
            mode: TreeMode::Gitlink,
            name: "vendor".to_string(),
            id: id_from_hex(&"aa".repeat(20)).unwrap(),
        }];
        let bytes = encode_tree(&entries, HashAlgo::Sha1).unwrap();
        let decoded = decode_tree(&bytes, HashAlgo::Sha1).unwrap();
        assert_eq!(decoded[0].mode, TreeMode::Gitlink);
        assert_eq!(id_hex(&decoded[0].id), "aa".repeat(20));
    }

    #[test]
    fn tree_refuses_slash_or_null_names() {
        let slash = encode_tree(
            &[TreeEntry {
                mode: TreeMode::Regular,
                name: "a/b".to_string(),
                id: id_from_hex(&"00".repeat(20)).unwrap(),
            }],
            HashAlgo::Sha1,
        );
        assert!(slash.is_err());
        let nul = encode_tree(
            &[TreeEntry {
                mode: TreeMode::Regular,
                name: "a\0b".to_string(),
                id: id_from_hex(&"00".repeat(20)).unwrap(),
            }],
            HashAlgo::Sha1,
        );
        assert!(nul.is_err());
    }

    // --- encodeCommit / decodeCommit ---

    fn empty_tree_id() -> Vec<u8> {
        id_from_hex("4b825dc642cb6eb9a060e54bf8d69288fbee4904").unwrap()
    }

    #[test]
    fn commit_roundtrips_no_parent() {
        let c = CommitObject {
            tree: empty_tree_id(),
            parents: vec![],
            author: pinned_person(),
            committer: pinned_person(),
            extra_headers: vec![],
            message: "initial commit\n".to_string(),
        };
        let bytes = encode_commit(&c, HashAlgo::Sha1).unwrap();
        let decoded = decode_commit(&bytes).unwrap();
        assert_eq!(decoded.tree, empty_tree_id());
        assert_eq!(decoded.parents.len(), 0);
        assert_eq!(decoded.message, "initial commit\n");
        assert_eq!(
            decoded.author.name_and_email,
            "Alice Doe <alice@example.com>"
        );
        assert_eq!(decoded.author.timestamp, 1735689600);
    }

    #[test]
    fn commit_roundtrips_multi_parent() {
        let c = CommitObject {
            tree: empty_tree_id(),
            parents: vec![
                id_from_hex(&"aa".repeat(20)).unwrap(),
                id_from_hex(&"bb".repeat(20)).unwrap(),
            ],
            author: pinned_person(),
            committer: pinned_person(),
            extra_headers: vec![],
            message: "merge\n".to_string(),
        };
        let bytes = encode_commit(&c, HashAlgo::Sha1).unwrap();
        let decoded = decode_commit(&bytes).unwrap();
        assert_eq!(decoded.parents.len(), 2);
        assert_eq!(id_hex(&decoded.parents[0]), "aa".repeat(20));
        assert_eq!(id_hex(&decoded.parents[1]), "bb".repeat(20));
    }

    #[test]
    fn commit_preserves_gpgsig() {
        let sig = "-----BEGIN PGP SIGNATURE-----\n…sig…\n-----END PGP SIGNATURE-----";
        let c = CommitObject {
            tree: empty_tree_id(),
            parents: vec![],
            author: pinned_person(),
            committer: pinned_person(),
            extra_headers: vec![ExtraHeader {
                name: "gpgsig".to_string(),
                value: sig.to_string(),
            }],
            message: "signed commit\n".to_string(),
        };
        let bytes = encode_commit(&c, HashAlgo::Sha1).unwrap();
        let decoded = decode_commit(&bytes).unwrap();
        let sig_header = decoded
            .extra_headers
            .iter()
            .find(|h| h.name == "gpgsig")
            .unwrap();
        assert_eq!(sig_header.value, sig);
    }

    #[test]
    fn commit_preserves_encoding_header() {
        let c = CommitObject {
            tree: empty_tree_id(),
            parents: vec![],
            author: pinned_person(),
            committer: pinned_person(),
            extra_headers: vec![ExtraHeader {
                name: "encoding".to_string(),
                value: "iso-8859-1".to_string(),
            }],
            message: "message\n".to_string(),
        };
        let bytes = encode_commit(&c, HashAlgo::Sha1).unwrap();
        let decoded = decode_commit(&bytes).unwrap();
        assert!(decoded.extra_headers.contains(&ExtraHeader {
            name: "encoding".to_string(),
            value: "iso-8859-1".to_string(),
        }));
    }

    // --- encodeTag / decodeTag ---

    #[test]
    fn tag_roundtrips_signed_annotated() {
        let target = id_from_hex(&"11".repeat(20)).unwrap();
        let t = TagObject {
            object: target,
            kind: ObjectKind::Commit,
            tag: "v1.0.0".to_string(),
            tagger: Some(pinned_person()),
            message: "release notes\n".to_string(),
        };
        let bytes = encode_tag(&t, HashAlgo::Sha1).unwrap();
        let decoded = decode_tag(&bytes).unwrap();
        assert_eq!(decoded.tag, "v1.0.0");
        assert_eq!(decoded.kind, ObjectKind::Commit);
        assert_eq!(id_hex(&decoded.object), "11".repeat(20));
    }

    #[test]
    fn id_equal_works() {
        assert!(id_equal(b"abc", b"abc"));
        assert!(!id_equal(b"abc", b"abd"));
        assert!(!id_equal(b"ab", b"abc"));
    }
}
