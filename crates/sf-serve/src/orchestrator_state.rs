//! Live orchestrator runtime state — the observable surface the control-panel
//! Orchestrator tab reads (issue #674).
//!
//! The gardening loop ([`sf_loop::GardeningLoop`]) and the daemon own the
//! authoritative process lifecycle; this module is the *observable projection*
//! of that lifecycle that the HTTP routes under `/orchestrator/*` and
//! `/analytics/*` serve. It is intentionally decoupled from the
//! [`LoopHandle`](crate::loop_handle::LoopHandle) drain/abort seam: that seam
//! controls the loop, this struct reports on it.
//!
//! # What it carries
//!
//! - **Process lifecycle**: a [`ProcessState`] (`stopped`/`starting`/`running`/
//!   `stopping`), the loop task PID-equivalent (the daemon process id), and the
//!   wall-clock instant the loop entered `running` (for uptime).
//! - **Loop health**: per-loop [`LoopHealth`] keyed by the three control-panel
//!   lanes (`plan`/`dev`/`doc`). v0 reports the gardening loop's health under
//!   `dev`; `plan`/`doc` default to healthy-idle.
//! - **Work slots**: the active [`WorkSlot`]s the Orchestrator slot cards render.
//! - **Live streams**: two `tokio::sync::broadcast` senders, one for log lines
//!   and one for CI/check-run events, that the SSE routes subscribe to.
//!
//! # Concurrency
//!
//! The struct is cheap to clone (it is `Arc`-wrapped internally) and every
//! mutable field is behind a parking-lot-free `std::sync::RwLock` or an atomic,
//! so route handlers read it without `.await` and the loop/daemon write it from
//! their own tasks.

use std::sync::atomic::{AtomicI64, AtomicU8, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Instant;

use serde::Serialize;
use tokio::sync::broadcast;

/// Broadcast channel capacity for the log and CI streams.
///
/// Subscribers that fall behind by more than this many messages observe a
/// `Lagged` error on the next recv; the SSE routes treat that as a benign
/// skip rather than a stream-ending error.
const STREAM_CAPACITY: usize = 256;

/// The process lifecycle state of the gardening loop, mirroring the
/// control-panel `ProcessState` union (`OrchestratorController.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProcessState {
    /// The loop is not running.
    Stopped,
    /// A start was requested; the loop task is spinning up.
    Starting,
    /// The loop is running and ticking.
    Running,
    /// A stop was requested; the loop is draining.
    Stopping,
}

impl ProcessState {
    fn as_u8(self) -> u8 {
        match self {
            ProcessState::Stopped => 0,
            ProcessState::Starting => 1,
            ProcessState::Running => 2,
            ProcessState::Stopping => 3,
        }
    }

    fn from_u8(v: u8) -> Self {
        match v {
            1 => ProcessState::Starting,
            2 => ProcessState::Running,
            3 => ProcessState::Stopping,
            _ => ProcessState::Stopped,
        }
    }
}

/// Per-loop health, mirroring the control-panel `LoopHealth` interface.
#[derive(Debug, Clone, Default, Serialize)]
pub struct LoopHealth {
    /// Unix-ms timestamp of the most recent tick, if any.
    #[serde(rename = "lastTickAt", skip_serializing_if = "Option::is_none")]
    pub last_tick_at: Option<i64>,
    /// Duration of the most recent tick in milliseconds, if measured.
    #[serde(rename = "lastTickDurationMs", skip_serializing_if = "Option::is_none")]
    pub last_tick_duration_ms: Option<i64>,
    /// Human-readable reason the loop is idle, if it is.
    #[serde(rename = "idleReason", skip_serializing_if = "Option::is_none")]
    pub idle_reason: Option<String>,
    /// Whether the loop's failure circuit breaker has tripped.
    #[serde(rename = "circuitTripped")]
    pub circuit_tripped: bool,
    /// Count of consecutive step failures.
    #[serde(rename = "consecutiveFailures")]
    pub consecutive_failures: u32,
}

/// One active work slot, mirroring the control-panel `SlotInfo` interface.
#[derive(Debug, Clone, Serialize)]
pub struct WorkSlot {
    /// Slot index (0-based).
    pub slot: u32,
    /// The issue number the slot is working.
    #[serde(rename = "issueNumber")]
    pub issue_number: i64,
    /// Slot role.
    pub role: String,
    /// Agent session id.
    #[serde(rename = "sessionId")]
    pub session_id: String,
    /// Execution backend label.
    pub backend: String,
    /// Model label.
    pub model: String,
    /// ISO-8601 start time.
    #[serde(rename = "startedAt")]
    pub started_at: String,
    /// Elapsed wall-clock time in milliseconds.
    #[serde(rename = "elapsedMs")]
    pub elapsed_ms: i64,
    /// Unix-ms timestamp of the last heartbeat, if any.
    #[serde(rename = "heartbeatAt", skip_serializing_if = "Option::is_none")]
    pub heartbeat_at: Option<i64>,
}

/// Shared, cheaply-cloneable handle to the live orchestrator state.
#[derive(Clone)]
pub struct OrchestratorState(Arc<Inner>);

struct Inner {
    /// Process lifecycle state (atomic so route reads are lock-free).
    process: AtomicU8,
    /// `Instant` the loop entered `Running`, stored as elapsed-ms since a
    /// fixed base via a monotonic millisecond counter. `i64::MIN` means unset.
    running_since_ms: AtomicI64,
    /// The daemon process id, exposed as the orchestrator "pid". `0` = unset.
    pid: AtomicI64,
    /// Per-loop health, keyed `plan`/`dev`/`doc`.
    loops: RwLock<LoopMap>,
    /// Active work slots.
    slots: RwLock<Vec<WorkSlot>>,
    /// Live log-line stream.
    log_tx: broadcast::Sender<String>,
    /// Live CI/check-run event stream (already-serialised JSON strings).
    ci_tx: broadcast::Sender<String>,
    /// Process start `Instant`, used to compute monotonic millis.
    base: Instant,
}

/// The three control-panel loop lanes.
#[derive(Debug, Clone, Default, Serialize)]
struct LoopMap {
    plan: LoopHealth,
    dev: LoopHealth,
    doc: LoopHealth,
}

impl Default for OrchestratorState {
    fn default() -> Self {
        Self::new()
    }
}

impl OrchestratorState {
    /// Build a fresh state in the `stopped` lifecycle with no slots.
    pub fn new() -> Self {
        let (log_tx, _) = broadcast::channel(STREAM_CAPACITY);
        let (ci_tx, _) = broadcast::channel(STREAM_CAPACITY);
        Self(Arc::new(Inner {
            process: AtomicU8::new(ProcessState::Stopped.as_u8()),
            running_since_ms: AtomicI64::new(i64::MIN),
            pid: AtomicI64::new(0),
            loops: RwLock::new(LoopMap::default()),
            slots: RwLock::new(Vec::new()),
            log_tx,
            ci_tx,
            base: Instant::now(),
        }))
    }

    fn now_ms(&self) -> i64 {
        self.0.base.elapsed().as_millis() as i64
    }

    /// Read the current process state.
    pub fn process_state(&self) -> ProcessState {
        ProcessState::from_u8(self.0.process.load(Ordering::Acquire))
    }

    /// Set the process state. Transitioning into `Running` stamps the uptime
    /// base; transitioning out of `Running` clears it.
    pub fn set_process_state(&self, state: ProcessState) {
        if state == ProcessState::Running {
            self.0
                .running_since_ms
                .store(self.now_ms(), Ordering::Release);
        } else if state == ProcessState::Stopped {
            self.0.running_since_ms.store(i64::MIN, Ordering::Release);
        }
        self.0.process.store(state.as_u8(), Ordering::Release);
    }

    /// Set the reported pid (the daemon process id). `0` clears it.
    pub fn set_pid(&self, pid: i64) {
        self.0.pid.store(pid, Ordering::Release);
    }

    /// The reported pid, or `None` when unset.
    pub fn pid(&self) -> Option<i64> {
        match self.0.pid.load(Ordering::Acquire) {
            0 => None,
            p => Some(p),
        }
    }

    /// Milliseconds the loop has been `Running`, or `None` when not running.
    pub fn uptime_ms(&self) -> Option<i64> {
        match self.0.running_since_ms.load(Ordering::Acquire) {
            i64::MIN => None,
            since => Some((self.now_ms() - since).max(0)),
        }
    }

    /// Snapshot the three loop lanes as a JSON-ready value.
    pub fn loops_json(&self) -> serde_json::Value {
        let guard = self.0.loops.read().expect("loops rwlock poisoned");
        serde_json::json!({
            "plan": guard.plan,
            "dev": guard.dev,
            "doc": guard.doc,
        })
    }

    /// Replace the `dev`-lane loop health (the gardening loop lane in v0).
    pub fn set_dev_loop_health(&self, health: LoopHealth) {
        let mut guard = self.0.loops.write().expect("loops rwlock poisoned");
        guard.dev = health;
    }

    /// Record a successful tick on the `dev` lane: stamp `lastTickAt`, clear the
    /// failure counter and circuit, and store the tick duration.
    pub fn record_dev_tick(&self, duration_ms: i64) {
        let mut guard = self.0.loops.write().expect("loops rwlock poisoned");
        guard.dev.last_tick_at = Some(self.unix_ms());
        guard.dev.last_tick_duration_ms = Some(duration_ms);
        guard.dev.consecutive_failures = 0;
        guard.dev.circuit_tripped = false;
        guard.dev.idle_reason = None;
    }

    /// Record a failed tick on the `dev` lane: bump the failure counter and trip
    /// the circuit once three consecutive failures accumulate.
    pub fn record_dev_failure(&self) {
        let mut guard = self.0.loops.write().expect("loops rwlock poisoned");
        guard.dev.consecutive_failures += 1;
        if guard.dev.consecutive_failures >= 3 {
            guard.dev.circuit_tripped = true;
        }
    }

    /// Snapshot the active work slots.
    pub fn slots(&self) -> Vec<WorkSlot> {
        self.0.slots.read().expect("slots rwlock poisoned").clone()
    }

    /// Replace the active work slots.
    pub fn set_slots(&self, slots: Vec<WorkSlot>) {
        *self.0.slots.write().expect("slots rwlock poisoned") = slots;
    }

    /// Publish a log line to all `/orchestrator/logs` subscribers.
    ///
    /// Returns the number of live subscribers (0 means no one is listening, not
    /// an error).
    pub fn publish_log(&self, line: impl Into<String>) -> usize {
        self.0.log_tx.send(line.into()).unwrap_or(0)
    }

    /// Subscribe to the log stream.
    pub fn subscribe_logs(&self) -> broadcast::Receiver<String> {
        self.0.log_tx.subscribe()
    }

    /// Publish a CI/check-run event (a JSON string) to all
    /// `/analytics/check-runs/stream` subscribers.
    pub fn publish_ci_event(&self, json: impl Into<String>) -> usize {
        self.0.ci_tx.send(json.into()).unwrap_or(0)
    }

    /// Subscribe to the CI/check-run event stream.
    pub fn subscribe_ci(&self) -> broadcast::Receiver<String> {
        self.0.ci_tx.subscribe()
    }

    /// Current wall-clock time as unix milliseconds.
    fn unix_ms(&self) -> i64 {
        chrono::Utc::now().timestamp_millis()
    }
}

impl std::fmt::Debug for OrchestratorState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OrchestratorState")
            .field("process", &self.process_state())
            .field("pid", &self.pid())
            .field("uptime_ms", &self.uptime_ms())
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn process_state_round_trips_through_u8() {
        for s in [
            ProcessState::Stopped,
            ProcessState::Starting,
            ProcessState::Running,
            ProcessState::Stopping,
        ] {
            assert_eq!(ProcessState::from_u8(s.as_u8()), s);
        }
    }

    #[test]
    fn uptime_is_none_until_running() {
        let st = OrchestratorState::new();
        assert_eq!(st.process_state(), ProcessState::Stopped);
        assert!(st.uptime_ms().is_none());

        st.set_process_state(ProcessState::Running);
        assert_eq!(st.process_state(), ProcessState::Running);
        assert!(st.uptime_ms().is_some());

        st.set_process_state(ProcessState::Stopped);
        assert!(st.uptime_ms().is_none());
    }

    #[test]
    fn pid_zero_reads_as_none() {
        let st = OrchestratorState::new();
        assert_eq!(st.pid(), None);
        st.set_pid(4242);
        assert_eq!(st.pid(), Some(4242));
        st.set_pid(0);
        assert_eq!(st.pid(), None);
    }

    #[test]
    fn dev_tick_resets_failures_and_circuit() {
        let st = OrchestratorState::new();
        st.record_dev_failure();
        st.record_dev_failure();
        st.record_dev_failure();
        let loops = st.loops_json();
        assert_eq!(loops["dev"]["consecutiveFailures"], 3);
        assert_eq!(loops["dev"]["circuitTripped"], true);

        st.record_dev_tick(123);
        let loops = st.loops_json();
        assert_eq!(loops["dev"]["consecutiveFailures"], 0);
        assert_eq!(loops["dev"]["circuitTripped"], false);
        assert_eq!(loops["dev"]["lastTickDurationMs"], 123);
    }

    #[test]
    fn slots_replace_round_trips() {
        let st = OrchestratorState::new();
        assert!(st.slots().is_empty());
        st.set_slots(vec![WorkSlot {
            slot: 0,
            issue_number: 674,
            role: "primary".into(),
            session_id: "sess-1".into(),
            backend: "claude".into(),
            model: "opus".into(),
            started_at: "2026-06-18T00:00:00Z".into(),
            elapsed_ms: 1000,
            heartbeat_at: Some(1_700_000_000_000),
        }]);
        let slots = st.slots();
        assert_eq!(slots.len(), 1);
        assert_eq!(slots[0].issue_number, 674);
    }

    #[tokio::test]
    async fn log_stream_delivers_to_subscriber() {
        let st = OrchestratorState::new();
        let mut rx = st.subscribe_logs();
        st.publish_log("hello");
        let got = rx.recv().await.expect("recv");
        assert_eq!(got, "hello");
    }

    #[tokio::test]
    async fn ci_stream_delivers_to_subscriber() {
        let st = OrchestratorState::new();
        let mut rx = st.subscribe_ci();
        st.publish_ci_event(r#"{"key":"k"}"#);
        let got = rx.recv().await.expect("recv");
        assert_eq!(got, r#"{"key":"k"}"#);
    }
}
