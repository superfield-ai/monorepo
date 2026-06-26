//! `sf-eval` — the Tier-2 live runner binary (issue #748).
//!
//! Usage:
//!
//! ```text
//! sf-eval run --scenario <dir> [--turn-budget N] [--workspace-id <uuid>] \
//!             [--poll-interval-secs S] [--results-root <dir>]
//! ```
//!
//! Drives a scenario through the **real** appliance and a live model (the
//! gardening loop the operator already booted via `superfield serve`), counting
//! turns by polling `orchestrator.gardening_cursor`, grading each poll, and
//! emitting `result.json` under `results/<scenario>/<workspace-id>/` (see
//! [`evals/runners/live.md`](../../../../evals/runners/live.md)).
//!
//! Seeding and serving are the operator's / workflow's responsibility — the
//! workflow starts a keyless `opencode serve`, sets
//! `SF_LLM_PROVIDER=opencode-server` (keyless: the local opencode server drives
//! the free Big Pickle model with no API key), seeds the intent
//! (`superfield garden <scenario>/seed/*.md`), and boots `superfield serve`;
//! this binary observes the running loop. It needs `DATABASE_URL` pointed at the
//! appliance's Postgres.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use nexum::embed::Embedder;
use nexum::{semantic_search, SemanticOptions};
use sf_eval::{
    compiling_candidate_pass, evaluate_run, project_graph_pass, Acceptance, DeterministicRungs,
    RunResult,
};
use sf_loop::load_cursor;
use uuid::Uuid;

/// The expected verbs the `todo-app` project-graph grader checks for.
const TODO_VERBS: &[&str] = &["add", "list", "complete"];

/// The query the deterministic semantic-search probe runs against the seeded,
/// embedded corpus. It mentions the todo verbs so a healthy governed embedder
/// retrieves the seed block; an empty result means embedding coverage is broken.
const SEMANTIC_PROBE_QUERY: &str = "add, list, and complete tasks in a todo app";

/// Default wall-clock budget the observer gives the live loop before it stops and
/// emits the result it has. A backstop well under the CI job wall so the runner
/// always exits cleanly (and uploads `result.json`) rather than being killed
/// mid-flight (issue #780). Override with `SF_EVAL_DEADLINE_SECS`.
const DEFAULT_DEADLINE_SECS: u64 = 1800;

struct Args {
    scenario_dir: PathBuf,
    turn_budget: u32,
    workspace_id: Uuid,
    poll_interval: Duration,
    results_root: PathBuf,
}

fn usage() -> ! {
    eprintln!(
        "usage: sf-eval run --scenario <dir> [--turn-budget N] [--workspace-id <uuid>] \
         [--poll-interval-secs S] [--results-root <dir>]"
    );
    std::process::exit(2);
}

fn parse_args() -> Args {
    let raw: Vec<String> = std::env::args().skip(1).collect();
    if raw.first().map(String::as_str) != Some("run") {
        usage();
    }

    let mut scenario_dir: Option<PathBuf> = None;
    let mut turn_budget: u32 = std::env::var("TURN_BUDGET")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(60);
    let mut workspace_id: Option<Uuid> = std::env::var("WORKSPACE_ID")
        .ok()
        .and_then(|s| Uuid::parse_str(&s).ok());
    let mut poll_secs: u64 = std::env::var("POLL_INTERVAL")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(5);
    let mut results_root = PathBuf::from("evals/results");

    let mut i = 1usize;
    while i < raw.len() {
        match raw[i].as_str() {
            "--scenario" => {
                i += 1;
                scenario_dir = raw.get(i).map(PathBuf::from);
            }
            "--turn-budget" => {
                i += 1;
                turn_budget = raw
                    .get(i)
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(turn_budget);
            }
            "--workspace-id" => {
                i += 1;
                workspace_id = raw.get(i).and_then(|s| Uuid::parse_str(s).ok());
            }
            "--poll-interval-secs" => {
                i += 1;
                poll_secs = raw.get(i).and_then(|s| s.parse().ok()).unwrap_or(poll_secs);
            }
            "--results-root" => {
                i += 1;
                results_root = raw.get(i).map(PathBuf::from).unwrap_or(results_root);
            }
            other => {
                eprintln!("sf-eval: unknown argument {other:?}");
                usage();
            }
        }
        i += 1;
    }

    Args {
        scenario_dir: scenario_dir.unwrap_or_else(|| usage()),
        turn_budget,
        workspace_id: workspace_id.unwrap_or_else(Uuid::new_v4),
        poll_interval: Duration::from_secs(poll_secs),
        results_root,
    }
}

/// Count `merge_result` rows in either Sharp episode model, so a compiling
/// candidate is detected whichever model the `CodeChangeProposal` step used
/// (see `evals/graders/compiling-candidate.md`).
async fn count_merge_results(pool: &sqlx::PgPool) -> u64 {
    let typed: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sharp.episode_typed_artifacts WHERE kind = 'merge_result'",
    )
    .fetch_one(pool)
    .await
    .unwrap_or(0);
    let generic: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sharp.episode_events WHERE event_type = 'merge_result'",
    )
    .fetch_one(pool)
    .await
    .unwrap_or(0);
    (typed.max(0) + generic.max(0)) as u64
}

/// Render the derived project graph as markdown by concatenating node content —
/// the input the structural `project-graph` grader checks.
async fn project_graph_markdown(pool: &sqlx::PgPool) -> String {
    match sf_db::list_nodes(pool, None).await {
        Ok(nodes) => nodes
            .into_iter()
            .map(|n| format!("- [{}] {}", n.node_type, n.content))
            .collect::<Vec<_>>()
            .join("\n"),
        Err(_) => String::new(),
    }
}

/// Count `nexum.page_revisions` rows for a workspace (corroborates turns).
async fn page_revision_count(pool: &sqlx::PgPool, workspace_id: Uuid) -> u32 {
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM nexum.page_revisions WHERE workspace_id = $1")
            .bind(workspace_id)
            .fetch_one(pool)
            .await
            .unwrap_or(0);
    count.max(0) as u32
}

/// The `seed` corpus id for a workspace, if the intent was seeded.
async fn seed_corpus_id(pool: &sqlx::PgPool, workspace_id: Uuid) -> Option<Uuid> {
    sqlx::query_scalar(
        "SELECT id FROM nexum.corpora WHERE name = 'seed' AND workspace_id = $1 LIMIT 1",
    )
    .bind(workspace_id)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten()
}

/// Count embedded blocks ingested into a corpus (the `ingest` rung's evidence).
async fn embedded_block_count(pool: &sqlx::PgPool, workspace_id: Uuid, corpus_id: Uuid) -> i64 {
    sqlx::query_scalar(
        "SELECT COUNT(*) FROM nexum.blocks b \
         JOIN nexum.documents d ON d.id = b.doc_id \
         WHERE d.workspace_id = $1 AND d.corpus_id = $2 AND b.embedding IS NOT NULL",
    )
    .bind(workspace_id)
    .bind(corpus_id)
    .fetch_one(pool)
    .await
    .unwrap_or(0)
}

/// Compute the deterministic rungs — the artifact's floor that does **not**
/// depend on the live-LLM loop converging (issue #780).
///
/// 1. `seed` — the seed corpus exists (the appliance's Seed step ran).
/// 2. `ingest` — at least one embedded block was ingested into it.
/// 3. `semantic_search` — the governed embedder retrieves a seeded block for a
///    todo-shaped query, proving end-to-end embedding coverage.
///
/// Each rung is gated on the previous one's evidence, so a downstream `false`
/// pinpoints where the offline pipeline actually broke.
async fn compute_deterministic_rungs(
    pool: &sqlx::PgPool,
    workspace_id: Uuid,
) -> DeterministicRungs {
    let mut rungs = DeterministicRungs::default();

    let Some(corpus_id) = seed_corpus_id(pool, workspace_id).await else {
        eprintln!("sf-eval: deterministic seed rung FAILED — no 'seed' corpus for workspace");
        return rungs;
    };
    rungs.seed = true;

    let embedded = embedded_block_count(pool, workspace_id, corpus_id).await;
    if embedded < 1 {
        eprintln!("sf-eval: deterministic ingest rung FAILED — no embedded blocks in seed corpus");
        return rungs;
    }
    rungs.ingest = true;

    // The semantic-search probe constructs the governed Embedder (offline,
    // cache-resolved in CI) and runs a real ANN query. A retrieval miss or an
    // embedder-init failure means embedding coverage is broken — record `false`
    // (the caller fails loudly), never silently skip.
    match Embedder::new() {
        Ok(embedder) => {
            let opts = SemanticOptions {
                workspace_id,
                corpus_id,
                query_text: SEMANTIC_PROBE_QUERY.to_string(),
                limit: 5,
            };
            match semantic_search(pool, &embedder, opts).await {
                Ok(hits) if !hits.is_empty() => rungs.semantic_search = true,
                Ok(_) => eprintln!(
                    "sf-eval: deterministic semantic_search rung FAILED — probe retrieved no blocks"
                ),
                Err(e) => eprintln!("sf-eval: semantic_search probe errored: {e}"),
            }
        }
        Err(e) => {
            eprintln!("sf-eval: governed Embedder init FAILED (weights missing offline?): {e}")
        }
    }

    rungs
}

/// Build a [`RunResult`] from the current observed state and write it to
/// `result.json`, returning the result so the caller can re-stamp/print it.
///
/// Called repeatedly: once up front (deterministic floor only) and again on every
/// poll, so the artifact on disk always reflects the latest state — even if the
/// process is later killed by the job wall.
#[allow(clippy::too_many_arguments)]
async fn flush_result(
    pool: &sqlx::PgPool,
    results_root: &Path,
    scenario: &str,
    workspace_id: Uuid,
    observations: &[String],
    turn_budget: u32,
    acceptance: Acceptance,
    deterministic: DeterministicRungs,
    elapsed: Duration,
    browser_smoke: &str,
) -> RunResult {
    let page_revisions = page_revision_count(pool, workspace_id).await;
    let mut result = evaluate_run(
        scenario.to_string(),
        workspace_id.to_string(),
        observations,
        turn_budget,
        page_revisions,
        acceptance,
        browser_smoke.to_string(),
    );
    result.deterministic = deterministic;
    result.elapsed_seconds = elapsed.as_secs();
    write_result(&result, results_root);
    result
}

#[tokio::main]
async fn main() {
    let args = parse_args();
    let scenario = args
        .scenario_dir
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("scenario")
        .to_string();

    let db_url = match std::env::var("DATABASE_URL") {
        Ok(u) if !u.is_empty() => u,
        _ => {
            eprintln!(
                "sf-eval: DATABASE_URL must point at the appliance Postgres to observe the loop"
            );
            std::process::exit(1);
        }
    };

    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(2)
        .connect(&db_url)
        .await
        .expect("connect to DATABASE_URL");

    let deadline = Duration::from_secs(
        std::env::var("SF_EVAL_DEADLINE_SECS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(DEFAULT_DEADLINE_SECS),
    );

    eprintln!(
        "sf-eval: observing scenario {scenario} (workspace {}, turn budget {}, deadline {}s)",
        args.workspace_id,
        args.turn_budget,
        deadline.as_secs()
    );

    let start = Instant::now();
    // The browser smoke is driven outside this binary (Playwright); record it as
    // skipped here unless a verdict was supplied via the environment.
    let browser_smoke = std::env::var("SF_EVAL_BROWSER_SMOKE").unwrap_or_else(|_| "skipped".into());

    // ── Deterministic floor ─────────────────────────────────────────────────
    // Compute the rungs that do NOT depend on the live-LLM loop (seed + ingest +
    // semantic-search), then flush result.json immediately. From here on the
    // artifact exists on disk and records real, executed rung verdicts — so even
    // a live loop that never converges (or a wall-killed process) still yields a
    // meaningful, parseable result (issue #780, AC2/AC3).
    let deterministic = compute_deterministic_rungs(&pool, args.workspace_id).await;
    eprintln!(
        "sf-eval: deterministic rungs: seed={} ingest={} semantic_search={}",
        deterministic.seed, deterministic.ingest, deterministic.semantic_search
    );

    let mut acceptance = Acceptance {
        project_graph: false,
        compiling_candidate: false,
    };
    let mut last = flush_result(
        &pool,
        &args.results_root,
        &scenario,
        args.workspace_id,
        &[],
        args.turn_budget,
        acceptance,
        deterministic,
        start.elapsed(),
        &browser_smoke,
    )
    .await;

    // Persist the agent's work products next to result.json so a run is
    // auditable even when the live loop never converges (or the floor fails):
    // the derived project graph the rung-1 grader reads, the rung-2 candidate
    // evidence, and the per-turn page-revision records. Written here (up front)
    // so even the loud floor-failure exit below still leaves them on disk for
    // the workflow's always() upload.
    let out_dir = run_dir(&args.results_root, &scenario, args.workspace_id);
    let floor_graph = project_graph_markdown(&pool).await;
    write_project_graph(&out_dir, &floor_graph);
    export_candidate_evidence(&pool, &out_dir).await;
    dump_turns(&pool, &out_dir, args.workspace_id).await;

    // Loud-skip discipline: a failed deterministic floor is a real broken
    // resource (no seed, no embedded blocks, or the governed embedder can't
    // retrieve) — fail the job. The artifact recording the failure is already on
    // disk for the workflow's always() upload step; do NOT proceed to fake a
    // green live run on top of a broken floor.
    if !deterministic.all_pass() {
        println!("{}", last.to_json());
        eprintln!(
            "sf-eval: deterministic floor FAILED (seed={} ingest={} semantic_search={}) — failing loudly",
            deterministic.seed, deterministic.ingest, deterministic.semantic_search
        );
        std::process::exit(1);
    }

    // ── Live loop observation ───────────────────────────────────────────────
    // Poll the cursor, grading each poll, re-flushing result.json so the latest
    // state is always durable. Stop on acceptance, turn-budget exhaustion, or the
    // wall-clock deadline (whichever first) — the deadline guarantees a clean
    // exit and upload well before the CI job wall, instead of being killed.
    let mut observations: Vec<String> = Vec::new();
    loop {
        if let Ok(Some(step)) = load_cursor(&pool, args.workspace_id).await {
            observations.push(step);
        }

        let graph_md = project_graph_markdown(&pool).await;
        // Refresh the persisted graph each poll so the artifact tracks the latest
        // derived state even if the process is later stopped at the deadline.
        write_project_graph(&out_dir, &graph_md);
        acceptance.project_graph = project_graph_pass(&graph_md, TODO_VERBS);
        acceptance.compiling_candidate = compiling_candidate_pass(count_merge_results(&pool).await);

        let elapsed = start.elapsed();
        last = flush_result(
            &pool,
            &args.results_root,
            &scenario,
            args.workspace_id,
            &observations,
            args.turn_budget,
            acceptance,
            deterministic,
            elapsed,
            &browser_smoke,
        )
        .await;

        let turns = sf_eval::count_turns(&observations);
        if acceptance.accepted() {
            eprintln!("sf-eval: accepted after {turns} turns");
            break;
        }
        if turns >= args.turn_budget {
            eprintln!(
                "sf-eval: turn budget {} exhausted (not accepted); deterministic floor already emitted",
                args.turn_budget
            );
            break;
        }
        if elapsed >= deadline {
            eprintln!(
                "sf-eval: wall-clock deadline {}s reached (not accepted); deterministic floor already emitted",
                deadline.as_secs()
            );
            break;
        }
        tokio::time::sleep(args.poll_interval).await;
    }

    // Final pass: re-export the work products so the artifact reflects the end
    // state (a candidate that landed on the last turn, the final graph + turns).
    let final_graph = project_graph_markdown(&pool).await;
    write_project_graph(&out_dir, &final_graph);
    export_candidate_evidence(&pool, &out_dir).await;
    dump_turns(&pool, &out_dir, args.workspace_id).await;

    println!("{}", last.to_json());
    let path = RunResult::result_path(
        &args.results_root,
        &scenario,
        &args.workspace_id.to_string(),
    );
    eprintln!("sf-eval: wrote {}", path.display());
}

fn write_result(result: &RunResult, results_root: &Path) -> PathBuf {
    result
        .write_under(results_root)
        .expect("write result.json under results root")
}

/// The directory a run's artifacts live in — `result.json` plus the persisted
/// work products this module writes next to it.
fn run_dir(results_root: &Path, scenario: &str, workspace_id: Uuid) -> PathBuf {
    results_root.join(scenario).join(workspace_id.to_string())
}

/// Persist the **derived project graph** the grader reads as `project-graph.md`
/// next to `result.json` (the README promises this file).
///
/// `graph_md` is the exact markdown [`project_graph_markdown`] hands the
/// `project_graph_pass` grader, so the artifact records the precise input the
/// rung-1 verdict was computed from. When the loop has derived no nodes yet the
/// file is written with an explicit marker — never silently absent, so a reader
/// can tell "no graph yet" from "harness forgot to write it".
fn write_project_graph(dir: &Path, graph_md: &str) {
    if let Err(e) = std::fs::create_dir_all(dir) {
        eprintln!("sf-eval: cannot create results dir for project-graph.md: {e}");
        return;
    }
    let body = if graph_md.trim().is_empty() {
        "# Derived project graph\n\n<!-- no project graph derived yet: the gardening \
         loop has produced no project_nodes for this workspace -->\n"
            .to_string()
    } else {
        format!("# Derived project graph\n\n{graph_md}\n")
    };
    if let Err(e) = std::fs::write(dir.join("project-graph.md"), body) {
        eprintln!("sf-eval: failed to write project-graph.md: {e}");
    }
}

/// Write one `merge_result` payload as `candidate-<seq>.json`, plus a
/// `candidate-<seq>.diff` when the payload carries a raw `diff`/`patch` string.
fn write_candidate(dir: &Path, seq: i64, payload: &serde_json::Value, found: &mut usize) {
    let json_path = dir.join(format!("candidate-{seq}.json"));
    let pretty = serde_json::to_string_pretty(payload).unwrap_or_else(|_| payload.to_string());
    if let Err(e) = std::fs::write(&json_path, pretty) {
        eprintln!("sf-eval: failed to write {}: {e}", json_path.display());
        return;
    }
    *found += 1;
    for key in ["diff", "patch"] {
        if let Some(text) = payload.get(key).and_then(|v| v.as_str()) {
            let diff_path = dir.join(format!("candidate-{seq}.diff"));
            if let Err(e) = std::fs::write(&diff_path, text) {
                eprintln!("sf-eval: failed to write {}: {e}", diff_path.display());
            }
            break;
        }
    }
}

/// Export the rung-2 candidate evidence — the `merge_result` records the
/// `compiling_candidate` grader counts — from both Sharp episode models.
///
/// The episode stores the merge **summary** (repo, merged_files, compile_gate),
/// not the raw source diff (the candidate's files live in the appliance
/// workspace, not the episode), so this dumps that JSON; a `diff`/`patch` string
/// field, if a future producer adds one, is additionally surfaced as a `.diff`.
/// When no `merge_result` exists the absence is **legitimate** (the stochastic
/// loop may never reach a compiling candidate) and is logged loudly rather than
/// fabricated.
async fn export_candidate_evidence(pool: &sqlx::PgPool, dir: &Path) {
    if let Err(e) = std::fs::create_dir_all(dir) {
        eprintln!("sf-eval: cannot create results dir for candidate evidence: {e}");
        return;
    }
    let mut found = 0usize;

    let events: Vec<(i64, serde_json::Value)> = sqlx::query_as(
        "SELECT seq, payload FROM sharp.episode_events \
         WHERE event_type = 'merge_result' ORDER BY seq",
    )
    .fetch_all(pool)
    .await
    .unwrap_or_default();
    for (seq, payload) in &events {
        write_candidate(dir, *seq, payload, &mut found);
    }

    let typed: Vec<(i64, Option<serde_json::Value>)> = sqlx::query_as(
        "SELECT seq, inline FROM sharp.episode_typed_artifacts \
         WHERE kind = 'merge_result' ORDER BY seq",
    )
    .fetch_all(pool)
    .await
    .unwrap_or_default();
    for (seq, inline) in &typed {
        if let Some(payload) = inline {
            write_candidate(dir, *seq, payload, &mut found);
        }
    }

    if found == 0 {
        eprintln!(
            "sf-eval: no compiling-candidate (merge_result) evidence to export — \
             legitimately absent (loop produced no compiling candidate)"
        );
    } else {
        eprintln!(
            "sf-eval: exported {found} candidate-evidence file(s) to {}",
            dir.display()
        );
    }
}

/// Dump the agent's per-turn records (`nexum.page_revisions`) for the workspace
/// to `turns.json`, so each gardening step's produced content + provenance is
/// inspectable in the uploaded artifact.
///
/// `ingested_at` is rendered to text in SQL to avoid a timestamp dependency. The
/// raw prompt/response the model exchanged is not in this table (see
/// `appliance.log` + `RUST_LOG` for that); these are the persisted step outputs.
async fn dump_turns(pool: &sqlx::PgPool, dir: &Path, workspace_id: Uuid) {
    if let Err(e) = std::fs::create_dir_all(dir) {
        eprintln!("sf-eval: cannot create results dir for turns.json: {e}");
        return;
    }
    let rows: Vec<(String, String, String, String)> = sqlx::query_as(
        "SELECT page_name, provenance, content, ingested_at::text \
         FROM nexum.page_revisions WHERE workspace_id = $1 ORDER BY ingested_at",
    )
    .bind(workspace_id)
    .fetch_all(pool)
    .await
    .unwrap_or_default();

    let turns: Vec<serde_json::Value> = rows
        .iter()
        .map(|(page_name, provenance, content, ingested_at)| {
            serde_json::json!({
                "page_name": page_name,
                "provenance": provenance,
                "ingested_at": ingested_at,
                "content_len": content.len(),
                "content": content,
            })
        })
        .collect();
    let doc = serde_json::json!({
        "workspace_id": workspace_id.to_string(),
        "turn_count": turns.len(),
        "turns": turns,
    });
    let path = dir.join("turns.json");
    match serde_json::to_string_pretty(&doc) {
        Ok(s) => {
            if let Err(e) = std::fs::write(&path, s) {
                eprintln!("sf-eval: failed to write turns.json: {e}");
                return;
            }
        }
        Err(e) => {
            eprintln!("sf-eval: failed to serialize turns.json: {e}");
            return;
        }
    }
    eprintln!(
        "sf-eval: dumped {} per-turn page_revision record(s) to turns.json",
        turns.len()
    );
}
