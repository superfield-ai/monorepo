//! The payload types that travel through a [`NotificationChannel`].

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Severity of a runtime signal, as judged by the caller (policy engine, signal
/// classifier, …).
///
/// Severity is *not* stored on `sharp.runtime_signals`; it is a notification-layer
/// concept so this crate stays decoupled from the signal schema. Only
/// [`SignalSeverity::is_high`] severities cause an outbound notification.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SignalSeverity {
    /// Informational; never pages a human.
    Low,
    /// Noteworthy but not urgent; never pages a human on its own.
    Medium,
    /// Urgent; a human is notified.
    High,
    /// Most urgent; a human is notified.
    Critical,
}

impl SignalSeverity {
    /// Canonical lowercase string for logs and wire payloads.
    pub fn as_str(self) -> &'static str {
        match self {
            SignalSeverity::Low => "low",
            SignalSeverity::Medium => "medium",
            SignalSeverity::High => "high",
            SignalSeverity::Critical => "critical",
        }
    }

    /// Whether this severity is high enough to warrant a human notification.
    ///
    /// `High` and `Critical` are notifiable; `Low` and `Medium` are not. This is
    /// the single severity judgement the channel makes (see the crate docs).
    pub fn is_high(self) -> bool {
        matches!(self, SignalSeverity::High | SignalSeverity::Critical)
    }
}

/// Which product trigger produced a [`Notification`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NotificationKind {
    /// A change entered `awaiting-approval` and needs a human decision.
    AwaitingApproval {
        /// The change awaiting approval (`forge.changes.id`).
        change_id: Uuid,
        /// Human-readable title of the change.
        title: String,
    },
    /// A high-severity runtime signal fired and needs human attention.
    HighSeveritySignal {
        /// Severity as judged by the caller.
        severity: SignalSeverity,
        /// Signal kind (`sharp.runtime_signals.signal_kind`, e.g. `"crash"`).
        signal_kind: String,
        /// Where the signal originated (e.g. `"pod/api-server"`).
        source: String,
        /// Raw message / behavioral description.
        message: String,
    },
}

impl NotificationKind {
    /// A short, stable type tag for routing/metrics.
    pub fn tag(&self) -> &'static str {
        match self {
            NotificationKind::AwaitingApproval { .. } => "awaiting_approval",
            NotificationKind::HighSeveritySignal { .. } => "high_severity_signal",
        }
    }
}

/// An outbound notification destined for the responsible human of a workspace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Notification {
    /// The workspace (tenant) the notification belongs to.
    pub workspace_id: Uuid,
    /// What triggered the notification.
    pub kind: NotificationKind,
    /// A one-line, human-readable summary suitable for an email subject or a
    /// chat line.
    pub summary: String,
    /// When the notification was constructed.
    pub created_at: DateTime<Utc>,
}

impl Notification {
    /// Build an awaiting-approval notification for `change_id`.
    pub fn awaiting_approval(workspace_id: Uuid, change_id: Uuid, title: &str) -> Self {
        Notification {
            workspace_id,
            summary: format!("Change awaiting approval: {title}"),
            kind: NotificationKind::AwaitingApproval {
                change_id,
                title: title.to_string(),
            },
            created_at: Utc::now(),
        }
    }

    /// Build a high-severity signal notification.
    pub fn high_severity_signal(
        workspace_id: Uuid,
        severity: SignalSeverity,
        signal_kind: &str,
        source: &str,
        message: &str,
    ) -> Self {
        Notification {
            workspace_id,
            summary: format!(
                "{} runtime signal [{signal_kind}] from {source}: {message}",
                severity.as_str()
            ),
            kind: NotificationKind::HighSeveritySignal {
                severity,
                signal_kind: signal_kind.to_string(),
                source: source.to_string(),
                message: message.to_string(),
            },
            created_at: Utc::now(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn severity_is_high_only_for_high_and_critical() {
        assert!(!SignalSeverity::Low.is_high());
        assert!(!SignalSeverity::Medium.is_high());
        assert!(SignalSeverity::High.is_high());
        assert!(SignalSeverity::Critical.is_high());
    }

    #[test]
    fn severity_ordering() {
        assert!(SignalSeverity::Low < SignalSeverity::Medium);
        assert!(SignalSeverity::Medium < SignalSeverity::High);
        assert!(SignalSeverity::High < SignalSeverity::Critical);
    }

    #[test]
    fn kind_tags_are_stable() {
        let a = Notification::awaiting_approval(Uuid::nil(), Uuid::nil(), "x");
        assert_eq!(a.kind.tag(), "awaiting_approval");
        let s = Notification::high_severity_signal(
            Uuid::nil(),
            SignalSeverity::Critical,
            "crash",
            "pod/api",
            "OOMKilled",
        );
        assert_eq!(s.kind.tag(), "high_severity_signal");
    }

    #[test]
    fn notification_round_trips_through_json() {
        let n = Notification::awaiting_approval(Uuid::nil(), Uuid::nil(), "Bump dep");
        let json = serde_json::to_string(&n).expect("serialize");
        let back: Notification = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(n, back);
    }
}
