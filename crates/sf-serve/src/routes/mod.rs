//! Route modules for the Superfield HTTP serving layer.
//!
//! | Module          | Prefix             | Auth     | Description                           |
//! |-----------------|--------------------|----------|---------------------------------------|
//! | [`auth`]        | `/api/auth/*`      | None     | Session issue and revoke              |
//! | [`api`]         | `/api/*`           | Required | App API (workspace-scoped)            |
//! | [`studio`]      | `/studio/*`        | Required | Control-panel API                     |
//! | [`orchestrator`]| `/orchestrator/*`  | Required | Orchestrator control endpoints        |
//! | [`pages`]       | `/pages/*`         | None     | Knowledge-base page projections       |
//! | [`project`]     | `/studio/*`        | Required | Project-graph API (dev-scout seam, #672) |
//! | [`ingest`]      | `/studio/*`        | Required | Knowledge ingest/docs API (dev-scout seam, #673) |
//!
//! # Additive registration seam (issue #677)
//!
//! [`project`] and [`ingest`] are **dev-scout no-op stubs** that register no
//! routes today. They give #672 and #673 each a dedicated route module so they
//! can land in parallel without colliding on a shared line in
//! [`crate::build_router`]. See [`crate::build_router`] for the merge point.

pub mod api;
pub mod auth;
pub mod ingest;
pub mod orchestrator;
pub mod pages;
pub mod project;
pub mod studio;
