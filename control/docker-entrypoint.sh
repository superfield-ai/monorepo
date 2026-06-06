#!/usr/bin/env bash
# docker-entrypoint.sh
#
# Initialises the studio server environment before starting the Bun process:
#
#   1. Builds an in-cluster kubeconfig so kubectl commands (cluster-info,
#      get pods --watch) work from inside the pod using the mounted
#      ServiceAccount token.
#
#   2. Creates a git repository at CALYPSO_REPO_ROOT with a .studio file
#      so that isStudioMode() and getStudioInfo() in api.ts return true.
#
#   3. Starts the studio Bun server.

set -euo pipefail

# ── In-cluster kubeconfig ─────────────────────────────────────────────────────

SA_TOKEN_PATH=/var/run/secrets/kubernetes.io/serviceaccount/token
SA_CA_PATH=/var/run/secrets/kubernetes.io/serviceaccount/ca.crt

if [[ -f "$SA_TOKEN_PATH" ]]; then
  KUBE_APISERVER="https://${KUBERNETES_SERVICE_HOST}:${KUBERNETES_SERVICE_PORT_HTTPS:-${KUBERNETES_SERVICE_PORT:-443}}"
  KUBECONFIG_PATH=/tmp/kubeconfig

  kubectl config set-cluster in-cluster \
    --server="${KUBE_APISERVER}" \
    --certificate-authority="${SA_CA_PATH}" \
    --kubeconfig="${KUBECONFIG_PATH}" \
    --embed-certs=true

  kubectl config set-credentials in-cluster \
    --token="$(cat "${SA_TOKEN_PATH}")" \
    --kubeconfig="${KUBECONFIG_PATH}"

  kubectl config set-context default \
    --cluster=in-cluster \
    --user=in-cluster \
    --kubeconfig="${KUBECONFIG_PATH}"

  kubectl config use-context default --kubeconfig="${KUBECONFIG_PATH}"
  export KUBECONFIG="${KUBECONFIG_PATH}"
else
  echo "[entrypoint] No ServiceAccount token found — kubectl will use KUBECONFIG from environment." >&2
fi

# ── Git repo initialisation ───────────────────────────────────────────────────

REPO_DIR="${CALYPSO_REPO_ROOT:-/studio-repo}"
mkdir -p "${REPO_DIR}"
cd "${REPO_DIR}"

if [[ ! -d ".git" ]]; then
  git init --quiet
  git config user.email "studio-e2e@test.local"
  git config user.name "Studio E2E"

  # .studio file: parsed by parseStudioInfo() in helpers.ts.
  # Requires both sessionId (string) and branch (string).
  printf '{"sessionId":"e2e-session","branch":"e2e-test"}\n' > .studio

  git add .
  git commit --quiet -m "Initial studio session"
fi

# ── Start the studio server ───────────────────────────────────────────────────

mkdir -p "${STUDIO_LOG_DIR:-/tmp/studio-logs}"

cd /app/apps/server
exec bun run src/index.ts
