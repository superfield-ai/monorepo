//! Route modules for the Superfield HTTP serving layer.
//!
//! | Module          | Prefix             | Auth     | Description                           |
//! |-----------------|--------------------|----------|---------------------------------------|
//! | [`auth`]        | `/api/auth/*`      | None     | Session issue and revoke              |
//! | [`api`]         | `/api/*`           | Required | App API (workspace-scoped)            |
//! | [`studio`]      | `/studio/*`        | Required | Control-panel API                     |
//! | [`orchestrator`]| `/orchestrator/*`  | Required | Orchestrator control endpoints        |
//! | [`pages`]       | `/pages/*`         | None     | Knowledge-base page projections       |

pub mod api;
pub mod auth;
pub mod orchestrator;
pub mod pages;
pub mod studio;
