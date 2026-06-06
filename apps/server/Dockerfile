# Sharp server — single-stage build using oven/bun base image.
# Runs the server directly with bun (no compile step) so workspace
# imports resolve at runtime against the copied source tree.

FROM oven/bun:1

WORKDIR /app

# Copy workspace manifests and lockfile first for layer caching
COPY package.json bun.lock ./
COPY apps/server/package.json apps/server/
COPY apps/client/package.json apps/client/
COPY packages/episodes/package.json packages/episodes/
COPY packages/git-canonical/package.json packages/git-canonical/

# Install all workspace dependencies with frozen lockfile for reproducibility
RUN bun install --frozen-lockfile --ignore-scripts

# Copy source
COPY . .

# Environment defaults
ENV SHARP_PORT=5174
ENV SHARP_LOG_LEVEL=info
ENV SHARP_MIGRATE_ON_BOOT=1
ENV SHARP_ALLOW_RAW_SHA1=1

EXPOSE 5174

CMD ["bun", "apps/server/src/index.ts"]
