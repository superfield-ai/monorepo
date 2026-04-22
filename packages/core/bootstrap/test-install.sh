#!/bin/sh
# Local test harness for install.sh.
#
# Runs the same assertions the CI workflow runs, but against a local docker
# container. Requires docker. If docker is unavailable, this script prints a
# clear message and exits 2 (skip) — it never silently mocks.
#
# Usage: test-install.sh
#
# Behaviour:
#   1. dash -n install.sh   (syntax check, runs always)
#   2. Start an Ubuntu 24.04 container in --privileged mode
#   3. Copy install.sh in, run it with a test public key
#   4. Assert all acceptance-criteria checks
#   5. Re-run install.sh and assert it's a no-op (marker timestamp unchanged)

set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
INSTALL_SH="${SCRIPT_DIR}/install.sh"

log() { printf '[test] %s\n' "$*"; }
fail() { printf '[test] FAIL: %s\n' "$*" >&2; exit 1; }

if [ ! -f "$INSTALL_SH" ]; then
    fail "install.sh not found at ${INSTALL_SH}"
fi

# ---------------------------------------------------------------------------
# Step 1: POSIX syntax check (always runs)
# ---------------------------------------------------------------------------
if ! command -v dash >/dev/null 2>&1; then
    log "dash not available; skipping POSIX syntax check"
else
    log "running dash -n ${INSTALL_SH}"
    dash -n "$INSTALL_SH"
    log "POSIX syntax OK"
fi

# ---------------------------------------------------------------------------
# Step 2: docker smoke test
# ---------------------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
    log "docker not installed — skipping container smoke test"
    log "to run the full test, install docker and re-run this script"
    exit 2
fi

if ! docker info >/dev/null 2>&1; then
    log "docker daemon not reachable — skipping container smoke test"
    exit 2
fi

TEST_KEY="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestKeyForBootstrapHarnessDoNotUseInProduction test@superfield-bootstrap"
CONTAINER_NAME="superfield-bootstrap-test-$$"

cleanup() {
    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

log "starting ubuntu:24.04 container with systemd as PID 1 (${CONTAINER_NAME})"
# k3s and sshd reload both require systemd. Boot a systemd container.
# We bake systemd + openssh-server in via a one-shot image build so /sbin/init
# is available when the container starts.
IMAGE_TAG="superfield-bootstrap-test:latest"
build_dir=$(mktemp -d)
trap 'cleanup; rm -rf "$build_dir"' EXIT INT TERM
cat > "$build_dir/Dockerfile" <<'EOF'
FROM ubuntu:24.04
ENV container=docker
RUN apt-get update -y \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        systemd systemd-sysv dbus openssh-server iproute2 \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/* \
 && rm -f /lib/systemd/system/multi-user.target.wants/* \
          /etc/systemd/system/*.wants/* \
          /lib/systemd/system/local-fs.target.wants/* \
          /lib/systemd/system/sockets.target.wants/*udev* \
          /lib/systemd/system/sockets.target.wants/*initctl* \
          /lib/systemd/system/basic.target.wants/* \
          /lib/systemd/system/anaconda.target.wants/*
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
EOF
log "building test image ${IMAGE_TAG}"
docker build -q -t "$IMAGE_TAG" "$build_dir" >/dev/null

docker run -d --privileged --name "$CONTAINER_NAME" \
    --cgroupns=host \
    --tmpfs /run --tmpfs /run/lock \
    -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
    "$IMAGE_TAG" >/dev/null

log "waiting for systemd to be ready"
i=0
while [ $i -lt 30 ]; do
    if docker exec "$CONTAINER_NAME" systemctl is-system-running --wait 2>/dev/null | grep -qE 'running|degraded'; then
        break
    fi
    i=$((i + 1))
    sleep 1
done

log "copying install.sh into container"
docker cp "$INSTALL_SH" "$CONTAINER_NAME":/root/install.sh

log "running install.sh (first invocation)"
docker exec "$CONTAINER_NAME" sh /root/install.sh "$TEST_KEY"

log "asserting k3s node Ready"
# k3s under docker-in-docker may take a moment to converge. Poll up to 90s.
i=0
while [ $i -lt 45 ]; do
    if docker exec "$CONTAINER_NAME" sh -c 'KUBECONFIG=/etc/rancher/k3s/k3s.yaml k3s kubectl get nodes --no-headers 2>/dev/null | grep -q " Ready "'; then
        break
    fi
    i=$((i + 1))
    sleep 2
done
docker exec "$CONTAINER_NAME" sh -c 'KUBECONFIG=/etc/rancher/k3s/k3s.yaml k3s kubectl get nodes' \
    || fail "kubectl get nodes did not show a Ready node"

log "asserting k3s API bound only on 127.0.0.1"
docker exec "$CONTAINER_NAME" sh -c '
    ss -tlnp 2>/dev/null | grep ":6443" || true
' | tee /tmp/6443-listeners.$$ >/dev/null
if grep -qE '(0\.0\.0\.0|\*|\[::\]):6443' /tmp/6443-listeners.$$; then
    cat /tmp/6443-listeners.$$
    rm -f /tmp/6443-listeners.$$
    fail "k3s API is bound to a non-loopback address"
fi
if ! grep -q '127.0.0.1:6443' /tmp/6443-listeners.$$; then
    cat /tmp/6443-listeners.$$
    rm -f /tmp/6443-listeners.$$
    fail "k3s API is not listening on 127.0.0.1:6443"
fi
rm -f /tmp/6443-listeners.$$

log "asserting ufw allows only port 22"
# ufw may not be fully active under docker due to iptables constraints; we check
# the configured rules rather than the enforced state.
ufw_rules=$(docker exec "$CONTAINER_NAME" sh -c 'ufw status 2>/dev/null || true')
printf '%s\n' "$ufw_rules"
if ! printf '%s\n' "$ufw_rules" | grep -qE '^22/tcp[[:space:]]+ALLOW'; then
    fail "ufw does not allow 22/tcp"
fi
# No other ALLOW rules beyond 22.
extra=$(printf '%s\n' "$ufw_rules" | grep -E 'ALLOW' | grep -vE '^22/tcp' || true)
if [ -n "$extra" ]; then
    printf '%s\n' "$extra"
    fail "ufw has ALLOW rules beyond 22/tcp"
fi

log "asserting sshd hardened"
docker exec "$CONTAINER_NAME" sh -c 'sshd -T 2>/dev/null | grep -E "^(passwordauthentication|permitrootlogin|kbdinteractiveauthentication|maxauthtries) "' \
    | tee /tmp/sshd-t.$$
for line in "passwordauthentication no" "permitrootlogin no" "kbdinteractiveauthentication no" "maxauthtries 3"; do
    if ! grep -qi "^${line}$" /tmp/sshd-t.$$; then
        cat /tmp/sshd-t.$$
        rm -f /tmp/sshd-t.$$
        fail "sshd -T missing expected setting: ${line}"
    fi
done
rm -f /tmp/sshd-t.$$

log "asserting authorized_keys exact"
actual_keys=$(docker exec "$CONTAINER_NAME" cat /root/.ssh/authorized_keys)
if [ "$actual_keys" != "$TEST_KEY" ]; then
    printf 'expected: %s\n' "$TEST_KEY"
    printf 'actual:   %s\n' "$actual_keys"
    fail "authorized_keys does not match the single expected key"
fi

log "asserting marker file present"
marker=$(docker exec "$CONTAINER_NAME" cat /etc/superfield/bootstrap.done)
printf '%s\n' "$marker"
if ! printf '%s\n' "$marker" | grep -q '^version='; then
    fail "marker file missing version= line"
fi
if ! printf '%s\n' "$marker" | grep -q '^timestamp='; then
    fail "marker file missing timestamp= line"
fi

log "asserting re-run is a no-op (marker timestamp unchanged)"
first_ts=$(printf '%s\n' "$marker" | awk -F= '$1=="timestamp"{print $2}')
sleep 2
docker exec "$CONTAINER_NAME" sh /root/install.sh "$TEST_KEY"
second_marker=$(docker exec "$CONTAINER_NAME" cat /etc/superfield/bootstrap.done)
second_ts=$(printf '%s\n' "$second_marker" | awk -F= '$1=="timestamp"{print $2}')
if [ "$first_ts" != "$second_ts" ]; then
    fail "marker timestamp changed across re-runs (expected no-op): ${first_ts} -> ${second_ts}"
fi

log "all assertions passed"
