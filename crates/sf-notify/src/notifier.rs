//! The dispatcher that maps product triggers onto outbound notifications.

use crate::channel::{NotificationChannel, NotifyError};
use crate::notification::{Notification, SignalSeverity};
use std::sync::Arc;
use uuid::Uuid;

/// Turns the two PRD §7 triggers into [`Notification`]s and hands them to a
/// [`NotificationChannel`].
///
/// The [`Notifier`] holds the transport behind an `Arc` so it can be cloned into
/// the daemon's async tasks (the change-lifecycle path and the runtime-signal
/// path) without re-wiring a transport each time.
///
/// It deliberately makes only one decision of its own — dropping non-high
/// severity signals — so the *when* of alerting stays in the policy engine and
/// the *whether the signal is loud enough to page a human* stays a single,
/// auditable rule here.
#[derive(Clone)]
pub struct Notifier {
    channel: Arc<dyn NotificationChannel>,
}

impl Notifier {
    /// Construct a notifier over the given transport.
    pub fn new(channel: Arc<dyn NotificationChannel>) -> Self {
        Notifier { channel }
    }

    /// Notify the responsible human that a change entered `awaiting-approval`.
    ///
    /// Always dispatches: reaching `awaiting-approval`
    /// (`sf_db::change::ChangeState::AwaitingApproval`) is itself the
    /// human-in-the-loop trigger. The caller invokes this after a successful
    /// transition into that state.
    pub async fn notify_awaiting_approval(
        &self,
        workspace_id: Uuid,
        change_id: Uuid,
        title: &str,
    ) -> Result<(), NotifyError> {
        let notification = Notification::awaiting_approval(workspace_id, change_id, title);
        tracing::info!(
            workspace_id = %workspace_id,
            change_id = %change_id,
            "dispatching awaiting-approval notification"
        );
        self.channel.dispatch(&notification).await
    }

    /// Notify the responsible human about a runtime signal, **iff** its severity
    /// is high enough ([`SignalSeverity::is_high`]).
    ///
    /// Returns `Ok(false)` without dispatching for low/medium signals so routine
    /// production noise never pages a human; `Ok(true)` once a high/critical
    /// signal has been dispatched.
    pub async fn notify_signal(
        &self,
        workspace_id: Uuid,
        severity: SignalSeverity,
        signal_kind: &str,
        source: &str,
        message: &str,
    ) -> Result<bool, NotifyError> {
        if !severity.is_high() {
            tracing::debug!(
                workspace_id = %workspace_id,
                severity = severity.as_str(),
                signal_kind,
                "suppressing notification for non-high-severity signal"
            );
            return Ok(false);
        }

        let notification = Notification::high_severity_signal(
            workspace_id,
            severity,
            signal_kind,
            source,
            message,
        );
        tracing::info!(
            workspace_id = %workspace_id,
            severity = severity.as_str(),
            signal_kind,
            source,
            "dispatching high-severity signal notification"
        );
        self.channel.dispatch(&notification).await?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::channel::InMemoryChannel;
    use crate::notification::NotificationKind;

    /// Acceptance criterion: a notification is dispatched to a fake transport
    /// when a change enters awaiting-approval.
    #[tokio::test]
    async fn dispatches_on_awaiting_approval() {
        let channel = Arc::new(InMemoryChannel::new());
        let notifier = Notifier::new(channel.clone());

        let workspace_id = Uuid::new_v4();
        let change_id = Uuid::new_v4();
        notifier
            .notify_awaiting_approval(workspace_id, change_id, "Bump serde to 1.0.200")
            .await
            .expect("dispatch must succeed");

        let dispatched = channel.dispatched();
        assert_eq!(dispatched.len(), 1, "exactly one notification expected");
        let n = &dispatched[0];
        assert_eq!(n.workspace_id, workspace_id);
        match &n.kind {
            NotificationKind::AwaitingApproval {
                change_id: cid,
                title,
            } => {
                assert_eq!(*cid, change_id);
                assert_eq!(title, "Bump serde to 1.0.200");
            }
            other => panic!("expected AwaitingApproval, got {other:?}"),
        }
    }

    /// Acceptance criterion: a notification is dispatched when a high-severity
    /// signal is recorded.
    #[tokio::test]
    async fn dispatches_on_high_severity_signal() {
        let channel = Arc::new(InMemoryChannel::new());
        let notifier = Notifier::new(channel.clone());

        let workspace_id = Uuid::new_v4();
        let fired = notifier
            .notify_signal(
                workspace_id,
                SignalSeverity::High,
                "crash",
                "pod/api-server",
                "OOMKilled: container exceeded memory limit",
            )
            .await
            .expect("dispatch must succeed");

        assert!(fired, "a high-severity signal must dispatch");
        let dispatched = channel.dispatched();
        assert_eq!(dispatched.len(), 1);
        assert_eq!(dispatched[0].workspace_id, workspace_id);
        assert!(matches!(
            dispatched[0].kind,
            NotificationKind::HighSeveritySignal { .. }
        ));
    }

    /// Acceptance criterion: a `critical` signal also dispatches.
    #[tokio::test]
    async fn dispatches_on_critical_signal() {
        let channel = Arc::new(InMemoryChannel::new());
        let notifier = Notifier::new(channel.clone());

        let fired = notifier
            .notify_signal(
                Uuid::new_v4(),
                SignalSeverity::Critical,
                "health_failure",
                "healthz",
                "probe failing for 5m",
            )
            .await
            .expect("dispatch must succeed");

        assert!(fired);
        assert_eq!(channel.count(), 1);
    }

    /// Acceptance criterion (negative case): no notification fires for a
    /// low-severity signal.
    #[tokio::test]
    async fn no_dispatch_for_low_severity_signal() {
        let channel = Arc::new(InMemoryChannel::new());
        let notifier = Notifier::new(channel.clone());

        let fired = notifier
            .notify_signal(
                Uuid::new_v4(),
                SignalSeverity::Low,
                "behavior",
                "metrics",
                "latency +5ms",
            )
            .await
            .expect("call must succeed");

        assert!(!fired, "low-severity signal must not dispatch");
        assert_eq!(channel.count(), 0, "no notification must be recorded");
    }

    /// A medium-severity signal is likewise suppressed (boundary of `is_high`).
    #[tokio::test]
    async fn no_dispatch_for_medium_severity_signal() {
        let channel = Arc::new(InMemoryChannel::new());
        let notifier = Notifier::new(channel.clone());

        let fired = notifier
            .notify_signal(
                Uuid::new_v4(),
                SignalSeverity::Medium,
                "error",
                "app",
                "warn",
            )
            .await
            .expect("call must succeed");

        assert!(!fired);
        assert_eq!(channel.count(), 0);
    }

    /// A transport failure surfaces as an error rather than being swallowed.
    #[tokio::test]
    async fn transport_error_surfaces() {
        let channel = Arc::new(InMemoryChannel::failing("webhook 503"));
        let notifier = Notifier::new(channel.clone());

        let err = notifier
            .notify_awaiting_approval(Uuid::new_v4(), Uuid::new_v4(), "x")
            .await
            .expect_err("transport failure must surface");
        assert!(matches!(err, NotifyError::Transport(_)));
        assert_eq!(channel.count(), 0);
    }
}
