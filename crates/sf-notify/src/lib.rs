//! Outbound notification channel for approvals and high-severity signals.
//!
//! PRD §7 requires alerting a human when a change awaits approval or a runtime
//! signal demands attention. This crate provides that outbound seam: a
//! [`NotificationChannel`] transport trait, at least one concrete transport
//! ([`WebhookChannel`]), and a [`Notifier`] dispatcher that turns the two
//! product triggers into [`Notification`]s.
//!
//! # Decoupling (it sends; the policy decides)
//!
//! This crate owns *delivery*, not the decision of *when* to alert. The
//! policy/governance engine decides that a change should await approval or that
//! a signal is worth a human's attention, then calls the [`Notifier`]:
//!
//! - [`Notifier::notify_awaiting_approval`] — always dispatches; reaching
//!   `awaiting-approval` is itself the human-in-the-loop trigger
//!   (`sf_db::change::ChangeState::AwaitingApproval`).
//! - [`Notifier::notify_signal`] — dispatches **only** for high-severity
//!   signals ([`SignalSeverity::is_high`]). A low/medium signal is dropped here
//!   so a flood of routine production noise never pages a human. This is the
//!   only severity judgement the channel makes; richer routing belongs in the
//!   policy engine, not here.
//!
//! Severity lives at the notification layer rather than mutating the Sharp
//! `runtime_signals` schema, so the channel stays decoupled from the signal
//! store: a caller maps whatever it knows (signal kind, payload, policy
//! verdict) to a [`SignalSeverity`] and passes it in.
//!
//! # Seam pattern
//!
//! [`NotificationChannel`] mirrors the established trait-seam style in the
//! workspace (`sf_loop::agent::AgentExecutor`,
//! `sf_db::provisioner::PostgresProvisioner`): a `Send + Sync` trait returning a
//! boxed future, a real transport, and an in-memory test transport
//! ([`InMemoryChannel`]) that captures every dispatched notification for
//! assertions.
//!
//! # Usage
//!
//! ```rust
//! use sf_notify::{Notifier, InMemoryChannel, SignalSeverity};
//! use std::sync::Arc;
//! use uuid::Uuid;
//!
//! # tokio_test::block_on(async {
//! let channel = Arc::new(InMemoryChannel::new());
//! let notifier = Notifier::new(channel.clone());
//!
//! // A change enters awaiting-approval → a human is alerted.
//! notifier
//!     .notify_awaiting_approval(Uuid::new_v4(), Uuid::new_v4(), "Bump dependency")
//!     .await
//!     .unwrap();
//!
//! // A high-severity runtime signal also alerts; a low-severity one does not.
//! notifier
//!     .notify_signal(Uuid::new_v4(), SignalSeverity::High, "crash", "pod/api", "OOMKilled")
//!     .await
//!     .unwrap();
//!
//! assert_eq!(channel.dispatched().len(), 2);
//! # });
//! ```
//!
//! See `docs/prd.md` §7 and `docs/architecture.md`.

mod channel;
mod notification;
mod notifier;

pub use channel::{InMemoryChannel, NotificationChannel, NotifyError, WebhookChannel};
pub use notification::{Notification, NotificationKind, SignalSeverity};
pub use notifier::Notifier;
