//! Project-graph API routes (`/studio/issues`, `/studio/features`, `/studio/steer`).
//!
//! # dev-scout seam (issue #677, downstream #672)
//!
//! This module is the **additive registration point** for the knowledge-to-work
//! feature API delivered by #672 (`feat(loop+api+cli): turn brain knowledge into
//! Feature/Issue project-graph nodes`). Today it registers **no routes** — the
//! [`router`] returns an empty [`Router`] that merges cleanly into the protected
//! route group in [`crate::build_router`].
//!
//! #672 fills this file in *without editing* [`crate::build_router`]'s merge
//! chain: it adds handlers here and `.route(...)` calls inside [`router`]. Because
//! the registration site is this dedicated module rather than a shared line in
//! `lib.rs`, #672 and #673 (see [`super::ingest`]) can land in parallel without a
//! router merge conflict.
//!
//! # Planned surface (NOT YET IMPLEMENTED — see #672)
//!
//! | Method | Path                | Backing call (`sf_db::project_graph`)        |
//! |--------|---------------------|----------------------------------------------|
//! | POST   | `/studio/issues`    | [`sf_db::project_graph::insert_issue`]       |
//! | POST   | `/studio/features`  | [`sf_db::project_graph::insert_feature`]     |
//! | GET    | `/studio/issues`    | [`sf_db::project_graph::traverse_project_graph`] |
//! | POST   | `/studio/steer`     | (state mutation on a Feature/Issue node)     |
//!
//! All handlers added here are auth-protected: [`crate::build_router`] wraps the
//! returned router in [`crate::auth::auth_middleware`]. Handlers must propagate
//! workspace context via [`sf_db::acquire_workspace`] exactly as [`super::api`]
//! and [`super::studio`] do, so per-schema RLS policies fire.
//!
//! # Write contract
//!
//! The project-graph write path that #672 will call is documented in
//! `crates/sf-db/src/project_graph.rs` (module docs §"Write contract for the
//! knowledge-to-work seam"). Created nodes read back through the existing
//! `GET /pages/project` projection ([`sf_db::project_graph::fetch_project_page`]).
//!
//! # Canonical docs
//!
//! - `docs/architecture.md` §Control Webapp / §Nexum — project management graph.
//! - Issue #677 (this seam), #672 (downstream feature).

use axum::Router;

use crate::state::AppState;

/// Build the project-graph API router.
///
/// **dev-scout stub:** returns an empty router — no routes registered yet. The
/// `state` is threaded through (and intentionally consumed via `.with_state`)
/// so #672 can add stateful handlers without changing this signature or the
/// call site in [`crate::build_router`].
///
/// All routes added here will be wrapped in the auth middleware by the caller
/// ([`crate::build_router`]).
pub fn router(state: AppState) -> Router {
    // No-op stub: register no routes today. #672 adds `.route(...)` calls here.
    Router::new().with_state(state)
}
