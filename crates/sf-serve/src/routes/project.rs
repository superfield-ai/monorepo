//! Empty project-graph route seam (originally dev-scout #677 for #672).
//!
//! # Status: dead/empty seam — does NOT implement the `/studio/issues` surface
//!
//! This module was the dev-scout registration point (#677) for the
//! knowledge-to-work feature (#672). **The actual project-graph API landed in
//! [`super::studio`] instead**, not here: the real `/studio/issues`,
//! `/studio/issues/update`, and `/studio/steer` handlers live in
//! `routes/studio.rs`. This module's [`router`] still returns an **empty
//! [`Router`]** that registers no routes; it is kept only so the merge chain in
//! [`crate::build_router`] does not need editing, and could be deleted (a
//! behavioral change tracked separately, out of scope for the doc-conformance
//! pass that wrote this comment).
//!
//! # Canonical docs
//!
//! - `docs/architecture.md` §Control Webapp / §Nexum — project management graph.
//! - The live project-graph API: [`super::studio`] and
//!   `crates/sf-db/src/project_graph.rs` (write contract).

use axum::Router;

use crate::state::AppState;

/// Build the (empty) project-graph router.
///
/// Returns an empty router — no routes are registered here. The real
/// project-graph routes live in [`super::studio`]. The `state` is threaded
/// through (and consumed via `.with_state`) only to keep this signature and the
/// call site in [`crate::build_router`] stable.
pub fn router(state: AppState) -> Router {
    // Empty seam: no routes. The project-graph API landed in `routes::studio`.
    Router::new().with_state(state)
}
