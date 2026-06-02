//! Route modules for the Superfield HTTP serving layer.
//!
//! | Module          | Prefix             | Description                           |
//! |-----------------|--------------------|---------------------------------------|
//! | [`auth`]        | `/api/auth/*`      | Session issue and revoke              |
//! | [`api`]         | `/api/*`           | App API (workspace-scoped, auth'd)    |
//! | [`studio`]      | `/studio/*`        | Control-panel API (auth'd)            |
//! | [`orchestrator`]| `/orchestrator/*`  | Orchestrator control endpoints (auth'd)|

pub mod api;
pub mod auth;
pub mod orchestrator;
pub mod studio;
