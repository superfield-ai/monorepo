# Dockerfile — Calypso Studio E2E test image
#
# This image is used exclusively by the E2E test suite (Layer 3 integration
# tests and Layer 4 Playwright E2E tests). It is NOT the production studio
# image — it contains a Claude bash stub instead of the real Claude CLI.
#
# ## What this image contains
#
#   - Bun runtime (oven/bun:1)
#   - git (for git operations in CALYPSO_REPO_ROOT)
#   - kubectl (in-cluster API server communication via ServiceAccount token)
#   - The studio Bun HTTP server (apps/server/)
#   - A static vanilla-JS E2E UI (tests/e2e/stub-ui/index.html) at STUDIO_ASSETS_DIR
#     (no React/Vite build — the stub-ui provides the required data-testid attributes)
#   - The Claude bash stub (tests/fixtures/claude-stub) at /usr/local/bin/claude
#
# ## Build and import into k3d (required before running E2E tests)
#
#   docker build -t calypso-studio:e2e .
#   k3d image import calypso-studio:e2e
#
# ## Runtime startup
#
#   docker-entrypoint.sh runs first and:
#     1. Writes /tmp/kubeconfig using the pod's ServiceAccount token (in-cluster)
#     2. Initialises a git repo at CALYPSO_REPO_ROOT with a .studio session file
#     3. Starts `bun run src/index.ts` from apps/server/
#
# ## Environment variables (see k8s/base/studio.yaml for k8s overrides)
#
#   STUDIO_PORT=3000               — The studio server listens here
#   STUDIO_ASSETS_DIR=/app/dist/web — Built React UI (served at GET /*)
#   STUDIO_WEB_SERVICE_HOST=web    — In-cluster DNS for the /app/* proxy target
#   STUDIO_WEB_SERVICE_PORT=80     — Port for the /app/* proxy target
#   STUDIO_CLUSTER_CONTEXT=default — kubectl context (matches in-cluster kubeconfig)
#   CALYPSO_REPO_ROOT=/studio-repo — Git repo root for .studio file and git ops
#   CLAUDE_STUB_LOG=/tmp/claude-stub.log — Log file for stub invocations
#
# See docs/studio-e2e-infrastructure.md for full architecture details.

# ── Single-stage runtime image ───────────────────────────────────────────────
# No multi-stage Vite build: the browser UI is a pre-written vanilla-JS file
# (tests/e2e/stub-ui/index.html) that carries the required data-testid
# attributes without any build tooling.
FROM oven/bun:1

# System tools: git (for REPO_ROOT git operations), curl + ca-certificates
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# kubectl — version pinned to match the k3s version used in CI (v1.29).
RUN KUBECTL_MINOR=1.29 && \
    KUBECTL_VERSION=$(curl -fsSL "https://dl.k8s.io/release/stable-${KUBECTL_MINOR}.txt") && \
    curl -fsSL "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl" \
         -o /usr/local/bin/kubectl && \
    chmod +x /usr/local/bin/kubectl

WORKDIR /app

# Copy workspace root manifests + server source + shared packages (no package.json
# in packages/*, so they are referenced via relative imports, not as npm packages).
COPY package.json bun.lock ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json    apps/web/package.json
COPY apps/server/             apps/server/
COPY packages/                packages/

# Install only production dependencies for the server.
RUN bun install --frozen-lockfile --production

# Copy the static stub UI (vanilla HTML/JS — no build step required).
# This is served by the studio server at STUDIO_ASSETS_DIR and provides
# the data-testid attributes that Playwright page objects assert on.
COPY tests/e2e/stub-ui/ /app/dist/web/

# Claude CLI stub — logged invocations go to CLAUDE_STUB_LOG.
COPY tests/fixtures/claude-stub /usr/local/bin/claude
RUN chmod +x /usr/local/bin/claude

COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

# Default environment — overridable via k8s Deployment env: section.
ENV STUDIO_PORT=3000
ENV STUDIO_ASSETS_DIR=/app/dist/web
ENV STUDIO_WEB_SERVICE_HOST=web
ENV STUDIO_WEB_SERVICE_PORT=80
ENV STUDIO_CLUSTER_CONTEXT=default
ENV STUDIO_LOG_DIR=/tmp/studio-logs
ENV CALYPSO_REPO_ROOT=/studio-repo
ENV CLAUDE_STUB_LOG=/tmp/claude-stub.log

EXPOSE 3000

ENTRYPOINT ["/docker-entrypoint.sh"]
