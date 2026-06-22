//! The outbound transport seam and its implementations.
//!
//! [`NotificationChannel`] is the seam through which a [`Notification`] leaves
//! the system. The daemon injects a concrete transport ([`WebhookChannel`]);
//! tests inject an [`InMemoryChannel`] that records every dispatched
//! notification. This mirrors `sf_loop::agent::AgentExecutor` and
//! `sf_db::provisioner::PostgresProvisioner`.

use crate::notification::Notification;
use std::future::Future;
use std::pin::Pin;
use std::sync::Mutex;
use thiserror::Error;

/// Boxed async future alias (matches the workspace seam convention).
type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Errors raised while dispatching a notification through a transport.
#[derive(Debug, Error)]
pub enum NotifyError {
    /// The transport failed to deliver (HTTP error, connection refused, …).
    #[error("transport error: {0}")]
    Transport(String),
    /// The notification could not be serialized for the transport.
    #[error("encode error: {0}")]
    Encode(String),
}

/// Seam interface for delivering a single [`Notification`] to its destination.
///
/// Implementations must be `Send + Sync` so the [`crate::Notifier`] can be
/// shared across the daemon's async tasks behind an `Arc`.
pub trait NotificationChannel: Send + Sync {
    /// Deliver one notification. Returns `Ok(())` on successful dispatch.
    fn dispatch<'a>(
        &'a self,
        notification: &'a Notification,
    ) -> BoxFuture<'a, Result<(), NotifyError>>;
}

// ---------------------------------------------------------------------------
// InMemoryChannel — test / fake transport
// ---------------------------------------------------------------------------

/// A fake transport that captures dispatched notifications in memory.
///
/// Used by tests to assert what was (and was not) sent. Optionally configured to
/// fail every dispatch so callers can exercise the error path.
#[derive(Debug, Default)]
pub struct InMemoryChannel {
    dispatched: Mutex<Vec<Notification>>,
    fail_with: Option<String>,
}

impl InMemoryChannel {
    /// A channel that records every dispatch and always succeeds.
    pub fn new() -> Self {
        InMemoryChannel {
            dispatched: Mutex::new(Vec::new()),
            fail_with: None,
        }
    }

    /// A channel that fails every dispatch with the given transport error.
    pub fn failing(reason: impl Into<String>) -> Self {
        InMemoryChannel {
            dispatched: Mutex::new(Vec::new()),
            fail_with: Some(reason.into()),
        }
    }

    /// A snapshot of every notification dispatched so far.
    pub fn dispatched(&self) -> Vec<Notification> {
        self.dispatched.lock().expect("dispatched lock").clone()
    }

    /// How many notifications have been dispatched.
    pub fn count(&self) -> usize {
        self.dispatched.lock().expect("dispatched lock").len()
    }
}

impl NotificationChannel for InMemoryChannel {
    fn dispatch<'a>(
        &'a self,
        notification: &'a Notification,
    ) -> BoxFuture<'a, Result<(), NotifyError>> {
        Box::pin(async move {
            if let Some(reason) = &self.fail_with {
                return Err(NotifyError::Transport(reason.clone()));
            }
            self.dispatched
                .lock()
                .expect("dispatched lock")
                .push(notification.clone());
            Ok(())
        })
    }
}

// ---------------------------------------------------------------------------
// WebhookChannel — concrete real transport
// ---------------------------------------------------------------------------

/// A concrete transport that POSTs the JSON-encoded [`Notification`] to a
/// configured webhook URL.
///
/// This is the one concrete transport required by issue #717 (in scope:
/// "one concrete transport"; out of scope: additional transports). The URL is
/// typically read from configuration (e.g. a Slack/Discord incoming webhook or
/// a generic HTTP endpoint) and the body is the serialized notification.
#[derive(Debug, Clone)]
pub struct WebhookChannel {
    url: String,
    client: reqwest::Client,
}

impl WebhookChannel {
    /// Create a webhook transport that POSTs notifications to `url`.
    pub fn new(url: impl Into<String>) -> Self {
        WebhookChannel {
            url: url.into(),
            client: reqwest::Client::new(),
        }
    }

    /// The configured destination URL.
    pub fn url(&self) -> &str {
        &self.url
    }
}

impl NotificationChannel for WebhookChannel {
    fn dispatch<'a>(
        &'a self,
        notification: &'a Notification,
    ) -> BoxFuture<'a, Result<(), NotifyError>> {
        Box::pin(async move {
            let body =
                serde_json::to_vec(notification).map_err(|e| NotifyError::Encode(e.to_string()))?;

            let resp = self
                .client
                .post(&self.url)
                .header("content-type", "application/json")
                .body(body)
                .send()
                .await
                .map_err(|e| NotifyError::Transport(e.to_string()))?;

            if resp.status().is_success() {
                Ok(())
            } else {
                Err(NotifyError::Transport(format!(
                    "webhook returned status {}",
                    resp.status()
                )))
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notification::Notification;
    use uuid::Uuid;

    #[tokio::test]
    async fn in_memory_records_dispatched_notifications() {
        let channel = InMemoryChannel::new();
        let n = Notification::awaiting_approval(Uuid::nil(), Uuid::nil(), "x");
        channel.dispatch(&n).await.expect("dispatch ok");
        assert_eq!(channel.count(), 1);
        assert_eq!(channel.dispatched()[0], n);
    }

    #[tokio::test]
    async fn failing_channel_does_not_record() {
        let channel = InMemoryChannel::failing("smtp down");
        let n = Notification::awaiting_approval(Uuid::nil(), Uuid::nil(), "x");
        let err = channel.dispatch(&n).await.expect_err("must fail");
        assert!(matches!(err, NotifyError::Transport(_)));
        assert_eq!(channel.count(), 0);
    }

    #[test]
    fn webhook_exposes_url() {
        let w = WebhookChannel::new("https://example.test/hook");
        assert_eq!(w.url(), "https://example.test/hook");
    }
}
