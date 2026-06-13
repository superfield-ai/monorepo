#!/usr/bin/env bash
# Superfield CLI installer
#
# Usage:
#   curl -fsSL https://superfield.dev/install.sh | bash
#   curl -fsSL https://superfield.dev/install.sh | bash -s -- --force
#
# Options:
#   --force     Overwrite an existing installation even if it is newer.
#   --dir <d>   Install to <d> instead of the default location.
#   --version   Install a specific tag (default: latest).

set -euo pipefail

REPO="superfield-ai/monorepo"
BINARY="superfield"
DEFAULT_INSTALL_DIR="${HOME}/.local/bin"

FORCE=0
INSTALL_DIR=""
TAG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --force)  FORCE=1; shift ;;
    --dir)    INSTALL_DIR="$2"; shift 2 ;;
    --version) TAG="v$2"; shift 2 ;;
    *)        echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

INSTALL_DIR="${INSTALL_DIR:-$DEFAULT_INSTALL_DIR}"

# Detect OS and architecture.
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Linux) OS_SLUG="linux" ;;
  *)
    echo "Unsupported OS: $OS (only Linux is supported)" >&2
    exit 1
    ;;
esac

case "$ARCH" in
  x86_64 | amd64) ARCH_SLUG="amd64" ;;
  arm64 | aarch64) ARCH_SLUG="arm64" ;;
  *)
    echo "Unsupported architecture: $ARCH" >&2
    exit 1
    ;;
esac

ASSET="${BINARY}-${OS_SLUG}-${ARCH_SLUG}"

# Resolve the release tag.
if [[ -z "$TAG" ]]; then
  echo "Fetching latest release tag…"
  TAG="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
    | grep '"tag_name"' \
    | head -1 \
    | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')"
  if [[ -z "$TAG" ]]; then
    echo "Could not determine the latest release tag." >&2
    exit 1
  fi
fi

DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${TAG}/${ASSET}"
INSTALL_PATH="${INSTALL_DIR}/${BINARY}"

# Version check — skip if --force is set or no existing installation.
if [[ -x "$INSTALL_PATH" && "$FORCE" -eq 0 ]]; then
  INSTALLED_VERSION="$("$INSTALL_PATH" --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"
  RELEASE_VERSION="${TAG#v}"
  if [[ -n "$INSTALLED_VERSION" && "$INSTALLED_VERSION" == "$RELEASE_VERSION" ]]; then
    echo "${BINARY} ${INSTALLED_VERSION} is already installed and up to date."
    exit 0
  fi
  if [[ -n "$INSTALLED_VERSION" ]]; then
    INSTALLED_MAJOR="${INSTALLED_VERSION%%.*}"
    RELEASE_MAJOR="${RELEASE_VERSION%%.*}"
    INSTALLED_MINOR="${INSTALLED_VERSION#*.}"; INSTALLED_MINOR="${INSTALLED_MINOR%%.*}"
    RELEASE_MINOR="${RELEASE_VERSION#*.}";  RELEASE_MINOR="${RELEASE_MINOR%%.*}"
    INSTALLED_PATCH="${INSTALLED_VERSION##*.}"
    RELEASE_PATCH="${RELEASE_VERSION##*.}"

    if (( INSTALLED_MAJOR > RELEASE_MAJOR )) || \
       (( INSTALLED_MAJOR == RELEASE_MAJOR && INSTALLED_MINOR > RELEASE_MINOR )) || \
       (( INSTALLED_MAJOR == RELEASE_MAJOR && INSTALLED_MINOR == RELEASE_MINOR && INSTALLED_PATCH >= RELEASE_PATCH )); then
      echo "Installed ${BINARY} ${INSTALLED_VERSION} is not older than ${RELEASE_VERSION}. Use --force to overwrite."
      exit 0
    fi
  fi
fi

echo "Installing ${BINARY} ${TAG} (${OS_SLUG}/${ARCH_SLUG}) → ${INSTALL_PATH}"

mkdir -p "$INSTALL_DIR"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

curl -fsSL "$DOWNLOAD_URL" -o "$TMP"
chmod +x "$TMP"
mv "$TMP" "$INSTALL_PATH"

echo "Installed successfully."

# Advise on PATH if the install dir isn't already on it.
if ! echo ":${PATH}:" | grep -q ":${INSTALL_DIR}:"; then
  echo ""
  echo "Add ${INSTALL_DIR} to your PATH by adding to your shell profile:"
  echo "  export PATH=\"${INSTALL_DIR}:\$PATH\""
fi

"$INSTALL_PATH" --version 2>/dev/null || true
