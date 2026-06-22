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

/// The aggregate cluster (appliance preview) health, mirroring the
/// control-panel `ClusterStatus` union (`ClusterStatusController.ts`).
///
/// The control panel's `IframePanel` keys its live-preview reload off these
/// transitions: when the cluster goes `Restarting` it shows a reloading
/// overlay, and on the `Restarting → Healthy` transition it clears the overlay
/// and reloads the embedded app so the developer sees the rebuilt preview.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ClusterStatus {
    /// The appliance preview is up and serving.
    Healthy,
    /// The appliance is restarting (hot-swap in progress).
    Restarting,
    /// The appliance is up but unhealthy (e.g. crash-looping).
    Degraded,
    /// Status is not yet known (no observation / stream just opened).
    Unknown,
}

impl ClusterStatus {
    fn as_u8(self) -> u8 {
        match self {
            ClusterStatus::Unknown => 0,
            ClusterStatus::Healthy => 1,
            ClusterStatus::Restarting => 2,
            ClusterStatus::Degraded => 3,
        }
    }

    fn from_u8(v: u8) -> Self {
        match v {
            1 => ClusterStatus::Healthy,
            2 => ClusterStatus::Restarting,
            3 => ClusterStatus::Degraded,
            _ => ClusterStatus::Unknown,
        }
    }

    /// The lowercase wire token the control-panel `ClusterStatusController`
    /// parses out of the `status` field of each `cluster-status` event.
    pub fn as_str(self) -> &'static str {
        match self {
            ClusterStatus::Healthy => "healthy",
            ClusterStatus::Restarting => "restarting",
            ClusterStatus::Degraded => "degraded",
            ClusterStatus::Unknown => "unknown",
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
    /// Accumulated US-dollar cost the slot's agent work has reported.
    ///
    /// PRD US10 requires monitoring every active agent including cost; the
    /// gardening loop populates this from the agent executor's reported cost so
    /// the Orchestrator slot cards show real, accumulating spend rather than
    /// nothing (issue #712).
    #[serde(rename = "costUsd")]
    pub cost_usd: f64,
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
    /// Current aggregate cluster (preview) status (atomic for lock-free reads).
    cluster: AtomicU8,
    /// Live cluster-status transition stream (the `status` token, e.g.
    /// `healthy`/`restarting`), feeding `GET /studio/cluster/events`.
    cluster_tx: broadcast::Sender<ClusterStatus>,
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

/// One of the three control-panel loop lanes a tick/failure is recorded against.
///
/// The gardening loop maps each step to a lane so the Orchestrator tab reports
/// live `plan` and `doc` health, not only `dev` (issue #712).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lane {
    /// Planning lane (`plan`).
    Plan,
    /// Development lane (`dev`).
    Dev,
    /// Documentation lane (`doc`).
    Doc,
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
        let (cluster_tx, _) = broadcast::channel(STREAM_CAPACITY);
        Self(Arc::new(Inner {
            process: AtomicU8::new(ProcessState::Stopped.as_u8()),
            running_since_ms: AtomicI64::new(i64::MIN),
            pid: AtomicI64::new(0),
            loops: RwLock::new(LoopMap::default()),
            slots: RwLock::new(Vec::new()),
            log_tx,
            ci_tx,
            cluster: AtomicU8::new(ClusterStatus::Unknown.as_u8()),
            cluster_tx,
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

    /// Record a successful tick on a specific lane: stamp `lastTickAt`, clear the
    /// failure counter and circuit, and store the tick duration.
    ///
    /// The gardening loop calls this with the lane the just-finished step maps
    /// to, so `plan`/`dev`/`doc` all report real health (issue #712).
    pub fn record_tick(&self, lane: Lane, duration_ms: i64) {
        let mut guard = self.0.loops.write().expect("loops rwlock poisoned");
        let health = Self::lane_mut(&mut guard, lane);
        health.last_tick_at = Some(self.unix_ms());
        health.last_tick_duration_ms = Some(duration_ms);
        health.consecutive_failures = 0;
        health.circuit_tripped = false;
        health.idle_reason = None;
    }

    /// Record a failed tick on a specific lane: bump the failure counter and trip
    /// the circuit once three consecutive failures accumulate.
    pub fn record_failure(&self, lane: Lane) {
        let mut guard = self.0.loops.write().expect("loops rwlock poisoned");
        let health = Self::lane_mut(&mut guard, lane);
        health.consecutive_failures += 1;
        if health.consecutive_failures >= 3 {
            health.circuit_tripped = true;
        }
    }

    /// Record a successful tick on the `dev` lane (convenience wrapper).
    pub fn record_dev_tick(&self, duration_ms: i64) {
        self.record_tick(Lane::Dev, duration_ms);
    }

    /// Record a failed tick on the `dev` lane (convenience wrapper).
    pub fn record_dev_failure(&self) {
        self.record_failure(Lane::Dev);
    }

    /// Borrow the [`LoopHealth`] for a lane out of the lane map.
    fn lane_mut(map: &mut LoopMap, lane: Lane) -> &mut LoopHealth {
        match lane {
            Lane::Plan => &mut map.plan,
            Lane::Dev => &mut map.dev,
            Lane::Doc => &mut map.doc,
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

    /// The current aggregate cluster (preview) status.
    pub fn cluster_status(&self) -> ClusterStatus {
        ClusterStatus::from_u8(self.0.cluster.load(Ordering::Acquire))
    }

    /// Set the aggregate cluster status, broadcasting the new value to all
    /// `/studio/cluster/events` subscribers **only when it changes**.
    ///
    /// De-duping on the stored value means the control-panel `IframePanel`
    /// reload (which fires on a `restarting → healthy` transition) is driven by
    /// real transitions, not by repeated identical observations. Returns the
    /// number of live subscribers that received the transition (0 when no one
    /// is listening, or when the status was unchanged).
    pub fn set_cluster_status(&self, status: ClusterStatus) -> usize {
        let prev = self.0.cluster.swap(status.as_u8(), Ordering::AcqRel);
        if prev == status.as_u8() {
            return 0;
        }
        self.0.cluster_tx.send(status).unwrap_or(0)
    }

    /// Subscribe to the cluster-status transition stream.
    pub fn subscribe_cluster(&self) -> broadcast::Receiver<ClusterStatus> {
        self.0.cluster_tx.subscribe()
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
    fn record_tick_targets_the_named_lane() {
        let st = OrchestratorState::new();
        // A plan tick lands on the plan lane and leaves dev/doc at defaults.
        st.record_tick(Lane::Plan, 7);
        let loops = st.loops_json();
        assert_eq!(loops["plan"]["lastTickDurationMs"], 7);
        assert!(loops["plan"]["lastTickAt"].is_i64());
        assert!(loops["dev"]["lastTickAt"].is_null());
        assert!(loops["doc"]["lastTickAt"].is_null());

        // A doc tick lands on the doc lane.
        st.record_tick(Lane::Doc, 9);
        let loops = st.loops_json();
        assert_eq!(loops["doc"]["lastTickDurationMs"], 9);
        assert!(loops["doc"]["lastTickAt"].is_i64());
    }

    #[test]
    fn record_failure_trips_per_lane_circuit() {
        let st = OrchestratorState::new();
        st.record_failure(Lane::Doc);
        st.record_failure(Lane::Doc);
        st.record_failure(Lane::Doc);
        let loops = st.loops_json();
        assert_eq!(loops["doc"]["consecutiveFailures"], 3);
        assert_eq!(loops["doc"]["circuitTripped"], true);
        // Other lanes are untouched.
        assert_eq!(loops["plan"]["consecutiveFailures"], 0);
    }

    #[test]
    fn work_slot_serializes_cost_usd() {
        let slot = WorkSlot {
            slot: 0,
            issue_number: 712,
            role: "doc".into(),
            session_id: "s".into(),
            backend: "gardening-loop".into(),
            model: "fixture".into(),
            started_at: "2026-06-19T00:00:00Z".into(),
            elapsed_ms: 1,
            heartbeat_at: None,
            cost_usd: 0.0125,
        };
        let v = serde_json::to_value(&slot).expect("serialize");
        assert_eq!(v["costUsd"], 0.0125);
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
            cost_usd: 0.25,
        }]);
        let slots = st.slots();
        assert_eq!(slots.len(), 1);
        assert_eq!(slots[0].issue_number, 674);
        assert_eq!(slots[0].cost_usd, 0.25);
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

    #[test]
    fn cluster_status_round_trips_through_u8() {
        for s in [
            ClusterStatus::Unknown,
            ClusterStatus::Healthy,
            ClusterStatus::Restarting,
            ClusterStatus::Degraded,
        ] {
            assert_eq!(ClusterStatus::from_u8(s.as_u8()), s);
        }
    }

    #[test]
    fn cluster_starts_unknown_and_records_changes() {
        let st = OrchestratorState::new();
        assert_eq!(st.cluster_status(), ClusterStatus::Unknown);
        st.set_cluster_status(ClusterStatus::Healthy);
        assert_eq!(st.cluster_status(), ClusterStatus::Healthy);
    }

    #[tokio::test]
    async fn cluster_stream_emits_only_on_transition() {
        let st = OrchestratorState::new();
        let mut rx = st.subscribe_cluster();

        // A change broadcasts; an identical repeat does not.
        assert_eq!(st.set_cluster_status(ClusterStatus::Restarting), 1);
        assert_eq!(st.set_cluster_status(ClusterStatus::Restarting), 0);
        assert_eq!(st.set_cluster_status(ClusterStatus::Healthy), 1);

        assert_eq!(rx.recv().await.expect("recv"), ClusterStatus::Restarting);
        assert_eq!(rx.recv().await.expect("recv"), ClusterStatus::Healthy);
    }

    /// The restart-to-healthy transition the IframePanel reload keys off is a
    /// real, ordered pair of distinct events on the stream.
    #[tokio::test]
    async fn restart_to_healthy_transition_is_observable() {
        let st = OrchestratorState::new();
        let mut rx = st.subscribe_cluster();
        st.set_cluster_status(ClusterStatus::Healthy);
        st.set_cluster_status(ClusterStatus::Restarting);
        st.set_cluster_status(ClusterStatus::Healthy);

        assert_eq!(rx.recv().await.unwrap(), ClusterStatus::Healthy);
        assert_eq!(rx.recv().await.unwrap(), ClusterStatus::Restarting);
        assert_eq!(rx.recv().await.unwrap(), ClusterStatus::Healthy);
    }
}
