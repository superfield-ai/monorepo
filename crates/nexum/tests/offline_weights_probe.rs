//! Scout probe (issue #770): the offline governed-weights resolution contract.
//!
//! This is a **stub / documentation** probe. It is `#[ignore]`d so it never
//! runs in the default `cargo test -p nexum` suite and changes no behaviour.
//! It does NOT download weights, does NOT assert inference, and is NOT a
//! required context. It pins, in executable form, the contract the required
//! embedder job (#760) verifies and the loud-fail path (#761) protects.
//!
//! # The contract this probe documents
//!
//! `Embedder::new()` (`crates/nexum/src/embed.rs`) calls
//! `hf_hub::api::sync::ApiRepo::get` for `config.json`, `tokenizer.json`, and
//! `model.safetensors`. In `hf-hub` 0.3.2, `get` is **cache-first then
//! network**:
//!
//! ```text
//! get(filename):
//!   if cache.repo(repo).get(filename) is Some(path) -> return path   (NO network)
//!   else                                            -> download()    (hits huggingface.co)
//! ```
//!
//! There is **no offline flag**: `HF_HUB_OFFLINE` / `TRANSFORMERS_OFFLINE` are
//! Python-only and ignored by the Rust crate. The only way to keep
//! `Embedder::new()` offline is to pre-populate the cache so the cache-HIT
//! branch is taken. A cache miss with no egress yields `RelativeUrlWithoutBase`
//! (the eval-todo-app Seed failure).
//!
//! # The exact cache tree the pre-population must create
//!
//! With `HF_HOME` defaulting to `~/.cache/huggingface`, the cache root is
//! `<HF_HOME>/hub`. `cache.get()` resolves the revision through a `refs/` file:
//!
//! ```text
//! <root>/models--sentence-transformers--all-MiniLM-L6-v2/
//!   refs/c9745ed                       # text file: the FULL 40-char commit SHA
//!   snapshots/<full-sha>/config.json
//!   snapshots/<full-sha>/tokenizer.json
//!   snapshots/<full-sha>/model.safetensors
//! ```
//!
//! `c9745ed` is [`nexum::embed::GOVERNED_MODEL_REVISION`] and is the `refs/`
//! **filename**; the `snapshots/<...>` directory is named with the **full**
//! commit SHA the refs file contains.
//!
//! # What #760 turns this into
//!
//! With the cache populated by the `governed-embed-weights` composite action
//! and huggingface.co egress blocked, the required job runs this probe with
//! `--include-ignored` and asserts `Embedder::new()` returns `Ok` resolving all
//! three files with no network. #761 makes the absence of the weights a LOUD
//! failure (non-zero exit) rather than a fall-through to `download()`.

use nexum::embed::{Embedder, GOVERNED_DIM, GOVERNED_MODEL, GOVERNED_MODEL_REVISION};

/// Pin the governed cache layout as compile-checked constants so the
/// pre-population step (composite action / bake) and this probe cannot drift.
///
/// Always runs (cheap, no network) — it only asserts the governance constants
/// the cache-path derivation depends on, documenting the pinned values.
#[test]
fn governed_cache_layout_is_pinned() {
    assert_eq!(GOVERNED_MODEL, "sentence-transformers/all-MiniLM-L6-v2");
    assert_eq!(GOVERNED_MODEL_REVISION, "c9745ed");
    assert_eq!(GOVERNED_DIM, 384);

    // The hf-hub repo folder name is `models--{repo_id}` with `/` -> `--`.
    let folder = format!("models--{}", GOVERNED_MODEL).replace('/', "--");
    assert_eq!(folder, "models--sentence-transformers--all-MiniLM-L6-v2");

    // The three files Embedder::new() resolves under snapshots/<full-sha>/.
    let required = ["config.json", "tokenizer.json", "model.safetensors"];
    assert_eq!(required.len(), 3);
}

/// SCOUT STUB — the offline-resolution probe #760 enables.
///
/// `#[ignore]`d so it never runs by default and never touches the network in
/// the scout PR. With the cache pre-populated (composite action) and egress
/// blocked, `Embedder::new()` must succeed resolving all three files offline.
#[test]
#[ignore = "scout stub: #760 enables this with the governed weights pre-populated offline"]
fn embedder_resolves_governed_weights_offline() {
    // Under #760 this runs with the cache warm and no egress: it must NOT hit
    // the network and must return Ok. A miss here is the loud failure (#761)
    // that replaces the silent fall-through to download().
    let embedder = Embedder::new().expect(
        "Embedder::new() must resolve governed weights from the pre-populated cache offline",
    );
    let v = embedder
        .embed_one("offline resolution probe")
        .expect("embed_one should succeed once weights resolve");
    assert_eq!(
        v.len(),
        GOVERNED_DIM,
        "offline-resolved embedder must still produce a {GOVERNED_DIM}-dim vector"
    );
}
