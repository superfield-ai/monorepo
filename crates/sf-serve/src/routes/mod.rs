//! Route modules for the Superfield HTTP serving layer.
//!
//! | Module          | Prefix             | Auth     | Description                           |
//! |-----------------|--------------------|----------|---------------------------------------|
//! | [`auth`]        | `/api/auth/*`      | None     | Session issue and revoke              |
//! | [`api`]         | `/api/*`           | Required | App API (workspace-scoped)            |
//! | [`studio`]      | `/studio/*`        | Required | Control-panel API                     |
//! | [`orchestrator`]| `/orchestrator/*`, `/analytics/*` | Required | Orchestrator control + loop/slot analytics + SSE streams (#674) |
//! | [`deploy`]      | `/studio/deploy/*` | Required | Deploy-tab env/doctor/CI + rollback/migration logs (#674) |
//! | [`cluster`]     | `/studio/cluster/*`| Required | Cluster-status SSE driving the live preview reload (#675) |
//! | [`pages`]       | `/pages/*`         | None     | Knowledge-base page projections       |
//! | [`change`]      | `/studio/changes/*`| Required | Change lifecycle read API (#707)      |
//! | [`project`]     | `/studio/*`        | Required | Project-graph API (dev-scout seam, #672) |
//! | [`ingest`]      | `/studio/*`        | Required | Knowledge ingest/docs API (dev-scout seam, #673) |
//! | [`ws`]          | `WS /studio/ws`    | Required | Agent-chat WebSocket seam (dev-scout stub, #695; feature #687) |
//!
//! # Additive registration seam (issue #677)
//!
//! [`project`] and [`ingest`] are **dev-scout no-op stubs** that register no
//! routes today. They give #672 and #673 each a dedicated route module so they
//! can land in parallel without colliding on a shared line in
//! [`crate::build_router`]. See [`crate::build_router`] for the merge point.

pub mod api;
pub mod auth;
pub mod change;
pub mod cluster;
pub mod deploy;
pub mod ingest;
pub mod orchestrator;
pub mod pages;
pub mod project;
pub mod studio;
pub mod ws;
