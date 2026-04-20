#!/bin/sh
# superfield bootstrap installer
#
# Brings a fresh Ubuntu 24.04 VM up to a hardened k3s host:
#   - installs apt prerequisites
#   - installs k3s bound to 127.0.0.1 with traefik disabled
#   - configures ufw to allow only inbound 22/tcp
#   - hardens sshd_config and reloads sshd
#   - replaces /root/.ssh/authorized_keys with the single key passed as $1
#   - writes /etc/superfield/bootstrap.done as the completion marker
#
# Idempotent: re-running skips steps whose effect is already present.
#
# Usage: install.sh "<authorized-public-key>"
#
# POSIX sh; verified with `dash -n install.sh`. No bashisms.

set -eu

BOOTSTRAP_VERSION="1"
MARKER_DIR="/etc/superfield"
MARKER_FILE="${MARKER_DIR}/bootstrap.done"
SSHD_CONFIG="/etc/ssh/sshd_config"
SSHD_DROPIN_DIR="/etc/ssh/sshd_config.d"
SSHD_DROPIN="${SSHD_DROPIN_DIR}/00-superfield.conf"
AUTHORIZED_KEYS="/root/.ssh/authorized_keys"

log() {
    printf '[bootstrap] %s\n' "$*"
}

err() {
    printf '[bootstrap] ERROR: %s\n' "$*" >&2
}

die() {
    err "$*"
    exit 1
}

require_root() {
    if [ "$(id -u)" -ne 0 ]; then
        die "must run as root"
    fi
}

usage() {
    cat >&2 <<'EOF'
Usage: install.sh "<authorized-public-key>"

The single argument must be the full public key line (e.g. "ssh-ed25519 AAAA... comment").
It will replace the contents of /root/.ssh/authorized_keys.
EOF
    exit 2
}

if [ "$#" -ne 1 ]; then
    usage
fi

AUTH_KEY="$1"

case "$AUTH_KEY" in
    "ssh-ed25519 "*|"ssh-rsa "*|"ssh-ecdsa "*|"ecdsa-sha2-"*|"sk-ssh-ed25519@openssh.com "*|"sk-ecdsa-sha2-nistp256@openssh.com "*)
        ;;
    *)
        die "argument does not look like an SSH public key (must start with a known key type)"
        ;;
esac

require_root

# ---------------------------------------------------------------------------
# Step 1: apt prerequisites
# ---------------------------------------------------------------------------
install_packages() {
    missing=""
    for pkg in curl ca-certificates iptables ufw; do
        if ! dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null | grep -q 'install ok installed'; then
            missing="${missing} ${pkg}"
        fi
    done

    if [ -z "$missing" ]; then
        log "apt prerequisites already installed; skipping"
        return 0
    fi

    log "installing apt prerequisites:${missing}"
    DEBIAN_FRONTEND=noninteractive apt-get update -y
    # shellcheck disable=SC2086
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${missing}
}

# ---------------------------------------------------------------------------
# Step 2: k3s
# ---------------------------------------------------------------------------
install_k3s() {
    if command -v k3s >/dev/null 2>&1 && systemctl is-active --quiet k3s; then
        log "k3s already installed and running; skipping installer"
        return 0
    fi

    log "installing k3s"
    if ! command -v curl >/dev/null 2>&1; then
        die "curl is required to install k3s"
    fi

    INSTALL_K3S_EXEC="--bind-address=127.0.0.1 --advertise-address=127.0.0.1 --tls-san=127.0.0.1 --disable=traefik" \
        curl -sfL https://get.k3s.io | sh -

    if ! systemctl is-active --quiet k3s; then
        die "k3s service failed to become active after install"
    fi
}

# ---------------------------------------------------------------------------
# Step 3: ufw
# ---------------------------------------------------------------------------
configure_ufw() {
    if ! command -v ufw >/dev/null 2>&1; then
        die "ufw is not installed"
    fi

    # Set default policies.
    ufw --force default deny incoming >/dev/null
    ufw --force default allow outgoing >/dev/null

    # Allow SSH only.
    if ! ufw status | grep -qE '^22/tcp[[:space:]]+ALLOW'; then
        ufw allow 22/tcp >/dev/null
    fi

    # Enable if not active.
    if ! ufw status | grep -q 'Status: active'; then
        log "enabling ufw"
        ufw --force enable >/dev/null
    else
        log "ufw already active"
    fi
}

# ---------------------------------------------------------------------------
# Step 4: sshd hardening
# ---------------------------------------------------------------------------
harden_sshd() {
    mkdir -p "$SSHD_DROPIN_DIR"

    desired=$(cat <<'EOF'
# Managed by superfield bootstrap. Do not edit.
PasswordAuthentication no
PermitRootLogin no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
MaxAuthTries 3
EOF
)

    current=""
    if [ -f "$SSHD_DROPIN" ]; then
        current=$(cat "$SSHD_DROPIN")
    fi

    if [ "$current" = "$desired" ]; then
        log "sshd hardening drop-in already present; skipping"
    else
        log "writing sshd hardening drop-in: $SSHD_DROPIN"
        printf '%s\n' "$desired" > "$SSHD_DROPIN"
        chmod 0644 "$SSHD_DROPIN"
    fi

    # Some sshd builds (and minimal containers) ignore drop-ins or have no Include
    # directive. Make sure the main config doesn't override us with weaker values.
    # We do this by ensuring the main config either lacks the directive or has the
    # same value. We never duplicate-append.
    enforce_in_main() {
        key="$1"
        val="$2"
        if grep -qE "^[[:space:]]*${key}[[:space:]]" "$SSHD_CONFIG" 2>/dev/null; then
            # Replace any existing line(s) with our value.
            tmp=$(mktemp)
            sed -E "s|^[[:space:]]*${key}[[:space:]].*|${key} ${val}|" "$SSHD_CONFIG" > "$tmp"
            if ! cmp -s "$tmp" "$SSHD_CONFIG"; then
                cat "$tmp" > "$SSHD_CONFIG"
            fi
            rm -f "$tmp"
        fi
    }

    enforce_in_main PasswordAuthentication no
    enforce_in_main PermitRootLogin no
    enforce_in_main KbdInteractiveAuthentication no
    enforce_in_main ChallengeResponseAuthentication no
    enforce_in_main MaxAuthTries 3

    # Validate config before reloading.
    if command -v sshd >/dev/null 2>&1; then
        if ! sshd -t 2>/dev/null; then
            die "sshd config validation failed after hardening"
        fi
    fi

    # Reload sshd if it's running. In containers (no init) this is a no-op.
    if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files 2>/dev/null | grep -qE '^ssh(d)?\.service'; then
        unit="ssh"
        if systemctl list-unit-files 2>/dev/null | grep -qE '^sshd\.service'; then
            unit="sshd"
        fi
        if systemctl is-active --quiet "$unit"; then
            log "reloading $unit"
            systemctl reload "$unit" || systemctl restart "$unit"
        else
            log "$unit not active; skipping reload"
        fi
    else
        log "systemctl unavailable or sshd unit absent; skipping reload"
    fi
}

# ---------------------------------------------------------------------------
# Step 5: authorized_keys
# ---------------------------------------------------------------------------
install_authorized_key() {
    mkdir -p /root/.ssh
    chmod 0700 /root/.ssh

    desired_line="$AUTH_KEY"
    current=""
    if [ -f "$AUTHORIZED_KEYS" ]; then
        current=$(cat "$AUTHORIZED_KEYS")
    fi

    if [ "$current" = "$desired_line" ]; then
        log "authorized_keys already matches; skipping"
    else
        log "writing /root/.ssh/authorized_keys"
        printf '%s\n' "$desired_line" > "$AUTHORIZED_KEYS"
        chmod 0600 "$AUTHORIZED_KEYS"
    fi
}

# ---------------------------------------------------------------------------
# Step 6: marker file
# ---------------------------------------------------------------------------
write_marker() {
    mkdir -p "$MARKER_DIR"

    if [ -f "$MARKER_FILE" ]; then
        existing_version=$(awk -F= '$1=="version"{print $2}' "$MARKER_FILE" 2>/dev/null || true)
        if [ "$existing_version" = "$BOOTSTRAP_VERSION" ]; then
            log "marker file already at version ${BOOTSTRAP_VERSION}; leaving timestamp unchanged"
            return 0
        fi
    fi

    ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    log "writing marker file ${MARKER_FILE} (version=${BOOTSTRAP_VERSION}, timestamp=${ts})"
    {
        printf 'version=%s\n' "$BOOTSTRAP_VERSION"
        printf 'timestamp=%s\n' "$ts"
    } > "$MARKER_FILE"
    chmod 0644 "$MARKER_FILE"
}

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------
log "starting superfield bootstrap (version ${BOOTSTRAP_VERSION})"
install_packages
install_k3s
configure_ufw
harden_sshd
install_authorized_key
write_marker
log "bootstrap complete"
