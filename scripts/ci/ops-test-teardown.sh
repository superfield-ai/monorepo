#!/usr/bin/env bash
# ops-test-teardown.sh — Clean up resources created by ops-test-setup.sh.
#
# Removes:
#   - The test postgres container
#   - The temporary SSH keypair
#   - The pubkey entry from ~/.ssh/authorized_keys

set -euo pipefail

SSH_TEST_KEY_DIR=/tmp/superfield-ops-test
SSH_TEST_PUBKEY="${SSH_TEST_KEY_DIR}/id_ed25519.pub"
AUTHORIZED_KEYS="${HOME}/.ssh/authorized_keys"
PG_CONTAINER=ops-test-pg

# ---------------------------------------------------------------------------
# 1. Remove postgres container
# ---------------------------------------------------------------------------
echo "==> [postgres] Removing test container..."
docker rm -f "${PG_CONTAINER}" 2>/dev/null || true
echo "==> [postgres] Done"

# ---------------------------------------------------------------------------
# 2. Remove pubkey from authorized_keys
# ---------------------------------------------------------------------------
echo "==> [ssh] Removing test pubkey from authorized_keys..."
if [ -f "${SSH_TEST_PUBKEY}" ] && [ -f "${AUTHORIZED_KEYS}" ]; then
  PUBKEY_CONTENT="$(cat "${SSH_TEST_PUBKEY}")"
  # Use a temp file to avoid in-place sed portability issues
  TMPFILE="$(mktemp)"
  grep -vF "${PUBKEY_CONTENT}" "${AUTHORIZED_KEYS}" > "${TMPFILE}" 2>/dev/null || true
  mv "${TMPFILE}" "${AUTHORIZED_KEYS}"
  chmod 600 "${AUTHORIZED_KEYS}"
  echo "==> [ssh] Pubkey removed"
else
  echo "==> [ssh] Pubkey or authorized_keys not found — skipping"
fi

# ---------------------------------------------------------------------------
# 3. Remove temp key directory
# ---------------------------------------------------------------------------
echo "==> [ssh] Removing temp key directory ${SSH_TEST_KEY_DIR}..."
rm -rf "${SSH_TEST_KEY_DIR}"
echo "==> [ssh] Done"

# ---------------------------------------------------------------------------
# 4. Summary
# ---------------------------------------------------------------------------
echo ""
echo "==> Teardown complete."
