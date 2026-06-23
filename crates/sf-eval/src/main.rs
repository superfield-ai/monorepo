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
use std::time::Duration;

use sf_eval::{compiling_candidate_pass, evaluate_run, project_graph_pass, Acceptance, RunResult};
use sf_loop::load_cursor;
use uuid::Uuid;

/// The expected verbs the `todo-app` project-graph grader checks for.
const TODO_VERBS: &[&str] = &["add", "list", "complete"];

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

    eprintln!(
        "sf-eval: observing scenario {scenario} (workspace {}, turn budget {})",
        args.workspace_id, args.turn_budget
    );

    // Poll the cursor, accumulating the observed step-name sequence, until the
    // gating rungs pass or the turn budget is exhausted.
    let mut observations: Vec<String> = Vec::new();
    let mut acceptance = Acceptance {
        project_graph: false,
        compiling_candidate: false,
    };

    loop {
        if let Ok(Some(step)) = load_cursor(&pool, args.workspace_id).await {
            observations.push(step);
        }

        let graph_md = project_graph_markdown(&pool).await;
        acceptance.project_graph = project_graph_pass(&graph_md, TODO_VERBS);
        acceptance.compiling_candidate = compiling_candidate_pass(count_merge_results(&pool).await);

        let turns = sf_eval::count_turns(&observations);
        if acceptance.accepted() {
            eprintln!("sf-eval: accepted after {turns} turns");
            break;
        }
        if turns >= args.turn_budget {
            eprintln!(
                "sf-eval: turn budget {} exhausted (not accepted)",
                args.turn_budget
            );
            break;
        }
        tokio::time::sleep(args.poll_interval).await;
    }

    let page_revisions = page_revision_count(&pool, args.workspace_id).await;
    // The browser smoke is driven outside this binary (Playwright); record it as
    // skipped here unless a verdict was supplied via the environment.
    let browser_smoke = std::env::var("SF_EVAL_BROWSER_SMOKE").unwrap_or_else(|_| "skipped".into());

    let result = evaluate_run(
        scenario,
        args.workspace_id.to_string(),
        &observations,
        args.turn_budget,
        page_revisions,
        acceptance,
        browser_smoke,
    );

    let path = write_result(&result, &args.results_root);
    println!("{}", result.to_json());
    eprintln!("sf-eval: wrote {}", path.display());
}

fn write_result(result: &RunResult, results_root: &Path) -> PathBuf {
    result
        .write_under(results_root)
        .expect("write result.json under results root")
}
