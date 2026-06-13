//! Real [`LoopHandle`] implementation for the gardening loop engine.
//!
//! [`GardeningLoopHandle`] wraps the Tokio channels that connect the daemon's
//! shutdown path to the background loop task.  The daemon stores one of these
//! in `AppState` as `Arc<dyn sf_serve::LoopHandle>`.
//!
//! # Drain / abort contract
//!
//! - `drain()`:  sends the drain signal and then awaits the "done" oneshot.
//!   Returns `Ok(())` once the loop has committed the current step's cursor
//!   and stopped cleanly.  Returns [`LoopHandleError::DrainChannelClosed`] if
//!   the loop task has already exited.
//! - `abort()`:  aborts the Tokio task immediately (no cursor commit guarantee).

use sf_serve::loop_handle::{LoopHandle, LoopHandleError};
use std::{
    future::Future,
    pin::Pin,
    sync::Mutex,
};
use tokio::{sync::oneshot, task::JoinHandle};

type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Real [`LoopHandle`] backed by Tokio oneshot channels and a [`JoinHandle`].
pub struct GardeningLoopHandle {
    /// Sends the drain signal to the loop.
    drain_tx: Mutex<Option<oneshot::Sender<()>>>,
    /// Resolves when the loop task has stopped cleanly.
    done_rx: Mutex<Option<oneshot::Receiver<()>>>,
    /// The Tokio task handle — used by `abort()`.
    task: JoinHandle<()>,
}

impl GardeningLoopHandle {
    /// Create a new handle.
    ///
    /// Called by [`crate::GardeningLoop::start`] immediately after spawning
    /// the background task.
    pub fn new(
        drain_tx: oneshot::Sender<()>,
        done_rx: oneshot::Receiver<()>,
        task: JoinHandle<()>,
    ) -> Self {
        Self {
            drain_tx: Mutex::new(Some(drain_tx)),
            done_rx: Mutex::new(Some(done_rx)),
            task,
        }
    }
}

impl LoopHandle for GardeningLoopHandle {
    fn drain(&self) -> BoxFuture<'_, Result<(), LoopHandleError>> {
        Box::pin(async move {
            // Send the drain signal.
            let tx = {
                let mut guard = self.drain_tx.lock().expect("drain_tx mutex poisoned");
                guard.take()
            };
            match tx {
                Some(tx) => {
                    // Ignore error: loop may have already exited.
                    let _ = tx.send(());
                }
                None => {
                    // drain() already called — still wait for done.
                }
            }

            // Await the done signal.
            let rx = {
                let mut guard = self.done_rx.lock().expect("done_rx mutex poisoned");
                guard.take()
            };
            match rx {
                Some(rx) => rx.await.map_err(|_| LoopHandleError::DrainChannelClosed),
                None => Ok(()), // already drained
            }
        })
    }

    fn abort(&self) -> BoxFuture<'_, Result<(), LoopHandleError>> {
        Box::pin(async move {
            self.task.abort();
            Ok(())
        })
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Spawn a trivial task, get a handle, drain it — drain must resolve.
    #[tokio::test]
    async fn drain_resolves_after_task_exits() {
        let (drain_tx, drain_rx) = oneshot::channel::<()>();
        let (done_tx, done_rx) = oneshot::channel::<()>();

        // Trivial task: waits for drain signal then sends done.
        let task = tokio::spawn(async move {
            let _ = drain_rx.await;
            let _ = done_tx.send(());
        });

        let handle = GardeningLoopHandle::new(drain_tx, done_rx, task);
        let result = handle.drain().await;
        assert!(result.is_ok(), "drain must return Ok(()) when loop exits cleanly");
    }

    /// Double drain returns Ok(()) without panicking.
    #[tokio::test]
    async fn drain_idempotent() {
        let (drain_tx, drain_rx) = oneshot::channel::<()>();
        let (done_tx, done_rx) = oneshot::channel::<()>();

        let task = tokio::spawn(async move {
            let _ = drain_rx.await;
            let _ = done_tx.send(());
        });

        let handle = GardeningLoopHandle::new(drain_tx, done_rx, task);
        handle.drain().await.expect("first drain");
        // Second call — done_rx already consumed; returns Ok(()) immediately.
        handle.drain().await.expect("second drain must not panic");
    }

    /// abort() returns Ok(()) even when task is already done.
    #[tokio::test]
    async fn abort_returns_ok() {
        let (drain_tx, _drain_rx) = oneshot::channel::<()>();
        let (_done_tx, done_rx) = oneshot::channel::<()>();

        let task = tokio::spawn(async {});
        let handle = GardeningLoopHandle::new(drain_tx, done_rx, task);
        assert!(handle.abort().await.is_ok());
    }
}
