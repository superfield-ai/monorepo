#!/usr/bin/env bash
# Run a `container: ghcr.io/superfield-ai/ci-runner:latest` CI workflow locally
# with stock `act`, injecting `node` into the job container the way GitHub's
# runner agent does — without modifying the ci-runner image or the workflow YAML.
#
# WHY THIS EXISTS
#   JavaScript GitHub Actions (actions/cache, actions/upload-artifact, hashFiles)
#   run under a `node` binary. GitHub's runner agent bind-mounts node into a
#   `container:` job at runtime; `act` does NOT (it has no `/__e` externals mount
#   — see act `pkg/runner/run_context.go` `options()`, which discards
#   `--container-options` for pinned-container jobs, and resolves node by exec'ing
#   bare `node` via PATH). The ci-runner image correctly omits node, so under act
#   the first JS action fails with `exec: "node": not found` (exit 127).
#
#   This script reproduces GitHub's *mechanism* (provide node at runtime) without
#   its plumbing: it runs a tiny background watcher that, the moment act starts a
#   ci-runner job container, `docker cp`s a glibc node20 onto the container PATH
#   (/usr/local/bin/node) before the first JS action runs. The workflow YAML is
#   unmodified, the production ci-runner image is untouched, and the local
#   `:latest` tag is never overwritten. node is DOWNLOADED to a cache dir on first
#   use (never vendored into the repo). See docs/testing.md
#   ("Running CI workflows locally with act") for the full mechanism + alternatives.
#
# USAGE
#   evals/scripts/run-local-act.sh [-- <extra act args>]
#   WORKFLOW=.github/workflows/eval-todo-app.yml \
#     evals/scripts/run-local-act.sh -- --input turn_budget=3
#
# Defaults run the eval-todo-app workflow end to end. Any args after `--` are
# passed through to `act` verbatim.
#
# PREREQS: Docker running; the ghcr.io/superfield-ai/ci-runner:latest image
# present locally (so --pull=false works without ghcr auth); `act` on PATH; curl + tar.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

WORKFLOW="${WORKFLOW:-.github/workflows/eval-todo-app.yml}"
EVENT="${EVENT:-workflow_dispatch}"
IMAGE="${CI_RUNNER_IMAGE:-ghcr.io/superfield-ai/ci-runner:latest}"
NODE_VERSION="${NODE_VERSION:-20.18.1}"
NODE_ARCH="${NODE_ARCH:-linux-x64}"
CACHE_DIR="${ACT_NODE_CACHE:-$HOME/.cache/superfield/act-node}"
ARTIFACTS="${ARTIFACT_PATH:-$(mktemp -d -t act-artifacts.XXXXXX)}"

NODE_BIN="$CACHE_DIR/node-v${NODE_VERSION}-${NODE_ARCH}/bin/node"

log() { printf '%s run-local-act: %s\n' "$(date +%T)" "$*" >&2; }

ensure_node() {
  if [ -x "$NODE_BIN" ]; then
    log "using cached glibc node $NODE_VERSION at $NODE_BIN"
    return
  fi
  local tarball url tmp
  tarball="node-v${NODE_VERSION}-${NODE_ARCH}.tar.xz"
  url="https://nodejs.org/dist/v${NODE_VERSION}/${tarball}"
  mkdir -p "$CACHE_DIR"
  tmp="$(mktemp -d)"
  log "downloading official glibc node $NODE_VERSION ($NODE_ARCH) from nodejs.org"
  curl -fsSL "$url" -o "$tmp/$tarball"
  # Verify the official checksum (best-effort: only enforce if shasum is present).
  if command -v sha256sum >/dev/null 2>&1; then
    local sums expected actual
    sums="$(curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" || true)"
    expected="$(printf '%s\n' "$sums" | awk -v f="$tarball" '$2==f{print $1}')"
    if [ -n "$expected" ]; then
      actual="$(sha256sum "$tmp/$tarball" | awk '{print $1}')"
      [ "$actual" = "$expected" ] || { log "checksum mismatch for $tarball"; exit 1; }
      log "checksum verified"
    fi
  fi
  tar -xJf "$tmp/$tarball" -C "$CACHE_DIR"
  rm -rf "$tmp"
  [ -x "$NODE_BIN" ] || { log "node binary missing after extract: $NODE_BIN"; exit 1; }
  log "node cached at $NODE_BIN"
}

# Background watcher: inject node into any ci-runner job container that lacks it.
watcher() {
  local deadline=$((SECONDS + ${WATCH_TIMEOUT:-5400}))
  while [ "$SECONDS" -lt "$deadline" ]; do
    local cid
    for cid in $(docker ps --filter "ancestor=$IMAGE" --format '{{.ID}}' 2>/dev/null); do
      if ! docker exec "$cid" sh -c 'command -v node' >/dev/null 2>&1; then
        if docker cp "$NODE_BIN" "$cid:/usr/local/bin/node" >/dev/null 2>&1; then
          log "injected node into job container $cid"
        fi
      fi
    done
    sleep 0.3
  done
}

main() {
  command -v docker >/dev/null || { log "docker not found"; exit 1; }
  command -v act >/dev/null || { log "act not found on PATH"; exit 1; }
  docker image inspect "$IMAGE" >/dev/null 2>&1 || {
    log "image $IMAGE not present locally; pull it (or build the ci-runner) first"; exit 1; }

  ensure_node

  watcher &
  local wpid=$!
  # shellcheck disable=SC2064
  trap "kill $wpid 2>/dev/null || true" EXIT INT TERM

  log "running act on $WORKFLOW ($EVENT); artifacts -> $ARTIFACTS"
  act -W "$WORKFLOW" "$EVENT" \
    --pull=false \
    --artifact-server-path "$ARTIFACTS" \
    "$@"
}

# Strip a leading `--` so callers can write `... -- --input turn_budget=3`.
if [ "${1:-}" = "--" ]; then shift; fi
main "$@"
