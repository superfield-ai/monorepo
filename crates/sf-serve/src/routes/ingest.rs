//! Knowledge ingest + docs API routes (`/studio/docs`, document write/upload).
//!
//! # dev-scout seam (issue #677, downstream #673)
//!
//! This module is the **additive registration point** for the web-authoring
//! ingest route delivered by #673 (`feat(web): author and upload knowledge from
//! the control panel via a server-side ingest route`). Today it registers **no
//! routes** — the [`router`] returns an empty [`Router`] that merges cleanly into
//! the protected route group in [`crate::build_router`].
//!
//! #673 fills this file in *without editing* [`crate::build_router`]'s merge
//! chain, so it can land in parallel with #672 (see [`super::project`]) without a
//! router merge conflict.
//!
//! # Planned surface (NOT YET IMPLEMENTED — see #673)
//!
//! | Method | Path                  | Backing call                              |
//! |--------|-----------------------|-------------------------------------------|
//! | POST   | `/studio/docs`        | server-side ingest seam (see below)       |
//! | GET    | `/studio/docs`        | list ingested documents                   |
//! | GET    | `/studio/docs/{file}` | fetch one document's content              |
//!
//! (The `WS /studio/ws` agent-chat surface in #673 is a separate websocket seam
//! and is out of scope for this route module.)
//!
//! # Server-side ingest seam
//!
//! The document write/upload handler runs the **same** ingest-and-embed pipeline
//! as the `superfield garden` CLI. The canonical entry point is
//! `nexum::ingest::ingest_document` (see its module docs §"Server-route seam
//! for web authoring"). #673's POST handler will:
//!
//! 1. Build a `nexum::ingest::IngestOptions` from the uploaded body, stamping
//!    `workspace_id` from the [`sf_auth::AuthContext`] extension.
//! 2. Call `nexum::ingest::ingest_document` with the shared pool and an
//!    `nexum::embed::Embedder`.
//! 3. Return the `nexum::ingest::IngestResult` summary.
//!
//! (`nexum` is not a `sf-serve` dependency today; #673 adds it to
//! `crates/sf-serve/Cargo.toml` when wiring the real handler.)
//!
//! Ingested content is then searchable through the existing brain search and
//! visible in the page projections, with no behaviour added by this seam.
//!
//! # Canonical docs
//!
//! - `docs/architecture.md` §Nexum — ingestion pipeline / §Control Webapp.
//! - Issue #677 (this seam), #673 (downstream feature).

use axum::Router;

use crate::state::AppState;

/// Build the knowledge-ingest / docs API router.
///
/// **dev-scout stub:** returns an empty router — no routes registered yet. The
/// `state` is threaded through so #673 can add stateful handlers without
/// changing this signature or the call site in [`crate::build_router`].
///
/// All routes added here will be wrapped in the auth middleware by the caller
/// ([`crate::build_router`]).
pub fn router(state: AppState) -> Router {
    // No-op stub: register no routes today. #673 adds `.route(...)` calls here.
    Router::new().with_state(state)
}
