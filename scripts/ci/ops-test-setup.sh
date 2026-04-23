#!/usr/bin/env bash
# ops-test-setup.sh — Prepare the self-hosted runner for ops integration tests.
#
# Sets up:
#   - k3s (single-node) with a kubeconfig readable by the runner user
#   - SSH loopback auth using a temporary ed25519 keypair
#   - A postgres container exposed on localhost:5432
#
# Idempotent: safe to re-run. Each step checks whether the resource already
# exists before creating it.
#
# Outputs (written to $GITHUB_ENV when available):
#   DEPLOY_KEY_FILE   — path to the generated private key PEM file
#   DEPLOY_HOST       — "127.0.0.1" (loopback)
#   DATABASE_URL_CI   — postgres URL for the test env

set -euo pipefail

SSH_TEST_KEY_DIR=/tmp/superfield-ops-test
SSH_TEST_KEY="${SSH_TEST_KEY_DIR}/id_ed25519"
SSH_TEST_PUBKEY="${SSH_TEST_KEY}.pub"
AUTHORIZED_KEYS="${HOME}/.ssh/authorized_keys"
PG_CONTAINER=ops-test-pg
PG_PORT=5432

# ---------------------------------------------------------------------------
# 1. Install k3s if not already present
# ---------------------------------------------------------------------------
echo "==> [k3s] Checking if k3s is installed..."
if ! command -v k3s &>/dev/null; then
  echo "==> [k3s] Installing k3s..."
  curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="--write-kubeconfig-mode 644 --disable traefik" sh -
else
  echo "==> [k3s] Already installed: $(k3s --version | head -1)"
fi

# Ensure k3s service is running
if ! systemctl is-active --quiet k3s 2>/dev/null; then
  echo "==> [k3s] Starting k3s service..."
  sudo systemctl start k3s || true
fi

# Export kubeconfig so kubectl works without sudo
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

echo "==> [k3s] Waiting for node to become Ready (up to 90s)..."
timeout 90 bash -c '
  until kubectl get nodes --no-headers 2>/dev/null | grep -q " Ready"; do
    echo "    ... waiting for k3s node"
    sleep 3
  done
'
echo "==> [k3s] Node is Ready:"
kubectl get nodes --no-headers

# ---------------------------------------------------------------------------
# 2. Generate SSH keypair for loopback auth
# ---------------------------------------------------------------------------
echo "==> [ssh] Setting up loopback SSH auth..."

mkdir -p "${SSH_TEST_KEY_DIR}"
chmod 700 "${SSH_TEST_KEY_DIR}"

if [ ! -f "${SSH_TEST_KEY}" ]; then
  echo "==> [ssh] Generating ed25519 keypair..."
  ssh-keygen -t ed25519 -C "superfield-ops-ci" -f "${SSH_TEST_KEY}" -N ""
else
  echo "==> [ssh] Keypair already exists at ${SSH_TEST_KEY}"
fi

# Ensure ~/.ssh exists
mkdir -p "${HOME}/.ssh"
chmod 700 "${HOME}/.ssh"
touch "${AUTHORIZED_KEYS}"
chmod 600 "${AUTHORIZED_KEYS}"

# Add pubkey to authorized_keys (idempotent via grep)
PUBKEY_CONTENT="$(cat "${SSH_TEST_PUBKEY}")"
if ! grep -qF "${PUBKEY_CONTENT}" "${AUTHORIZED_KEYS}" 2>/dev/null; then
  echo "==> [ssh] Adding pubkey to authorized_keys..."
  echo "${PUBKEY_CONTENT}" >> "${AUTHORIZED_KEYS}"
else
  echo "==> [ssh] Pubkey already in authorized_keys"
fi

# Ensure sshd is running
echo "==> [ssh] Ensuring sshd is running..."
if command -v systemctl &>/dev/null; then
  sudo systemctl start ssh 2>/dev/null || sudo systemctl start sshd 2>/dev/null || true
elif [ -f /etc/init.d/ssh ]; then
  sudo /etc/init.d/ssh start 2>/dev/null || true
fi

# Warm the loopback known_hosts entry so superfield doesn't reject it
KNOWN_HOSTS_SF="${HOME}/.ssh/known_hosts.superfield"
touch "${KNOWN_HOSTS_SF}"
chmod 600 "${KNOWN_HOSTS_SF}"
if ! ssh-keygen -F "127.0.0.1" -f "${KNOWN_HOSTS_SF}" &>/dev/null; then
  echo "==> [ssh] Scanning 127.0.0.1 into known_hosts.superfield..."
  ssh-keyscan -H 127.0.0.1 >> "${KNOWN_HOSTS_SF}" 2>/dev/null || true
fi

# Quick loopback connectivity smoke-test
echo "==> [ssh] Testing loopback SSH connection..."
ssh -i "${SSH_TEST_KEY}" \
  -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null \
  -o BatchMode=yes \
  -p 22 \
  "$(whoami)@127.0.0.1" \
  "echo 'loopback-ssh-ok'" || {
  echo "WARN: loopback SSH test failed — tests requiring SSH will be skipped"
}

# ---------------------------------------------------------------------------
# 3. Start postgres container
# ---------------------------------------------------------------------------
echo "==> [postgres] Setting up test postgres container..."

if docker ps --format '{{.Names}}' | grep -q "^${PG_CONTAINER}$"; then
  echo "==> [postgres] Container already running"
elif docker ps -a --format '{{.Names}}' | grep -q "^${PG_CONTAINER}$"; then
  echo "==> [postgres] Starting existing container..."
  docker start "${PG_CONTAINER}"
else
  echo "==> [postgres] Creating and starting postgres container..."
  docker run -d \
    --name "${PG_CONTAINER}" \
    -e POSTGRES_PASSWORD=test \
    -e POSTGRES_DB=superfield_ci \
    -p "${PG_PORT}:5432" \
    postgres:16-alpine
fi

echo "==> [postgres] Waiting for pg_isready (up to 30s)..."
timeout 30 bash -c "
  until docker exec ${PG_CONTAINER} pg_isready -U postgres &>/dev/null; do
    echo '    ... waiting for postgres'
    sleep 2
  done
"
echo "==> [postgres] Postgres is ready"

# ---------------------------------------------------------------------------
# 4. Export environment variables for subsequent workflow steps
# ---------------------------------------------------------------------------
echo "==> [env] Exporting test environment variables..."

DATABASE_URL_CI="postgres://postgres:test@localhost:${PG_PORT}/superfield_ci"

if [ -n "${GITHUB_ENV:-}" ]; then
  # Running in GitHub Actions — export to job env
  echo "DEPLOY_HOST=127.0.0.1"             >> "${GITHUB_ENV}"
  echo "DEPLOY_KEY_FILE=${SSH_TEST_KEY}"   >> "${GITHUB_ENV}"
  echo "DATABASE_URL_CI=${DATABASE_URL_CI}" >> "${GITHUB_ENV}"
  echo "KUBECONFIG=/etc/rancher/k3s/k3s.yaml" >> "${GITHUB_ENV}"
else
  # Running locally — print exports for manual sourcing
  echo ""
  echo "# Source these exports in your shell:"
  echo "export DEPLOY_HOST=127.0.0.1"
  echo "export DEPLOY_KEY_FILE=${SSH_TEST_KEY}"
  echo "export DATABASE_URL_CI=${DATABASE_URL_CI}"
  echo "export KUBECONFIG=/etc/rancher/k3s/k3s.yaml"
fi

# ---------------------------------------------------------------------------
# 5. Summary
# ---------------------------------------------------------------------------
echo ""
echo "==> Setup complete:"
echo "    SSH key:    ${SSH_TEST_KEY}"
echo "    SSH host:   127.0.0.1"
echo "    Postgres:   ${DATABASE_URL_CI}"
echo "    Kubeconfig: /etc/rancher/k3s/k3s.yaml"
