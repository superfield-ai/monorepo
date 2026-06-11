# Sharp Server Configuration

Configuration reference for the Sharp server (`apps/server/src/index.ts`). All options are read from environment variables at startup; there is no config file for the server itself.

---

## Environment Variables

### `SHARP_DSN` (required)

Postgres connection string. The server refuses to start if this is missing.

```
SHARP_DSN=postgres://user:pass@localhost:5432/sharp
```

Supports all standard libpq DSN forms. The server opens a pool of connections on startup and verifies connectivity before accepting requests. Use a connection string that includes the database name; Sharp does not create the database itself.

---

### `SHARP_PORT`

HTTP listen port. Default: `5174`.

```
SHARP_PORT=8080
```

---

### `SHARP_LOG_LEVEL`

Structured log verbosity. Accepted values: `info`, `debug`, `warn`, `error`. Default: `info`.

```
SHARP_LOG_LEVEL=debug
```

All logs are written to stdout as JSON with fields `ts`, `level`, `request_id`, `repo`, `route`, `latency_ms`, `outcome`.

---

### `SHARP_AUTH_DISABLED`

Set to `1` to bypass bearer-token authentication entirely. **Development only — never set in production.**

```
SHARP_AUTH_DISABLED=1
```

When auth is disabled every request is treated as if it carries an operator-scope token. This is useful for local development before you have issued any tokens.

---

### `SHARP_MIGRATE_ON_BOOT`

Controls whether the server applies pending SQL migrations at startup. Default behavior is to run migrations; set to `0` to skip.

```
SHARP_MIGRATE_ON_BOOT=0   # operator will run migrations manually
```

Migrations are applied in a transaction; a failed migration rolls back and the server exits with a non-zero status. Setting this to `0` is useful when running migrations through a separate deployment step (e.g., a Kubernetes init container) rather than letting each pod race to apply them.

---

### `SHARP_ALLOW_RAW_SHA1`

Set to `1` to accept SHA-1 object hashes without running SHA-1DC (collision-detection variant) on intake. **Required until SHA-1DC is fully wired; development only.**

```
SHARP_ALLOW_RAW_SHA1=1
```

In production, Sharp runs SHA-1DC on every ingested object and rejects anything that triggers collision-detection. That safeguard is not yet wired end-to-end in v1; setting this flag bypasses the check so development and testing are not blocked. Do not leave it set in production once SHA-1DC is available.

See also the Git interop doc for how this flag relates to `sharp git import`.

---

### `SHARP_HOOK_TIMEOUT_MS`

Wall-clock timeout in milliseconds for each hook execution. Default: `60000` (60 seconds).

```
SHARP_HOOK_TIMEOUT_MS=120000
```

Applies to all hook events (`pre-commit`, `pre-merge`, `pre-push`, `pre-receive`). A hook that exceeds the timeout is killed and treated as a failure (veto for veto-capable events, error for `pre-receive`). Increase this for slow language toolchains (e.g., a cold `cargo check` on a large workspace).

---

### `SHARP_SLOW_QUERY_MS`

Queries that take longer than this threshold (in milliseconds) emit a `warn`-level log entry with the parameterized SQL text and `EXPLAIN` output. Default: `250`.

```
SHARP_SLOW_QUERY_MS=500
```

Set to a very large value (e.g., `999999`) to suppress slow-query logging in development environments where it is noisy.

---

## Deployment

### Direct (Bun binary)

The server is a single Bun script with no build step required for development:

```bash
SHARP_DSN=postgres://user:pass@localhost:5432/sharp \
SHARP_ALLOW_RAW_SHA1=1 \
bun apps/server/src/index.ts
```

For production, build a self-contained binary:

```bash
bun build --compile apps/server/src/index.ts --outfile sharp-server
SHARP_DSN=postgres://... ./sharp-server
```

### Docker Compose

```yaml
version: '3.9'
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_DB: sharp
      POSTGRES_USER: sharp
      POSTGRES_PASSWORD: changeme
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U sharp']
      interval: 5s
      timeout: 3s
      retries: 10

  server:
    image: oven/bun:1
    working_dir: /app
    volumes:
      - .:/app
    command: bun apps/server/src/index.ts
    environment:
      SHARP_DSN: postgres://sharp:changeme@db:5432/sharp
      SHARP_PORT: '5174'
      SHARP_LOG_LEVEL: info
    ports:
      - '5174:5174'
    depends_on:
      db:
        condition: service_healthy

volumes:
  pgdata:
```

---

## Migrations

Migrations live under `apps/server/migrations/` as plain SQL files, applied in lexicographic order. A `schema_migrations(version, applied_at)` table tracks which files have been applied; migrations are never re-run.

**Automatic (default).** The server applies all pending migrations on startup before accepting connections. This is the right choice for most deployments.

**Manual.** Set `SHARP_MIGRATE_ON_BOOT=0` and run the migration script directly:

```bash
SHARP_DSN=postgres://... bun apps/server/migrate.ts
```

This is useful when:

- Running migrations as a separate Kubernetes Job before rolling out new server pods.
- Inspecting the migration plan before applying it in a sensitive environment.
- Rolling back a bad migration by shipping a new forward migration that undoes it (Sharp does not support down-migrations; moving forward only is the convention).

The `/readyz` endpoint returns a non-OK response until migrations have been applied and the database is reachable.

---

## Issuing Tokens

Tokens are required for all API calls unless `SHARP_AUTH_DISABLED=1`. The `sharp admin issue-token` command creates a token and prints the secret once; store it in a secure credential store.

```bash
# Issue an operator-scope token for a human operator
SHARP_URL=http://localhost:5174 \
SHARP_TOKEN=<existing-operator-token> \
bun apps/client/src/cli.ts admin issue-token \
  --principal alice \
  --scope operator

# Issue a write-scope token for an agent harness
SHARP_URL=http://localhost:5174 \
SHARP_TOKEN=<existing-operator-token> \
bun apps/client/src/cli.ts admin issue-token \
  --principal codex-worker \
  --scope write
```

Available scopes:

| Scope              | Grants                                                                                   |
| ------------------ | ---------------------------------------------------------------------------------------- |
| `read`             | Object/ref/representation/episode reads                                                  |
| `write`            | Everything in `read` plus object puts, ref CAS, commit/episode writes, git import/export |
| `operator`         | Everything in `write` plus `POST /repos`, `POST /repos/:repo/query`                      |
| `read_no_episodes` | Object/ref/representation reads, but no raw episode traces                               |

The token secret is shown exactly once at creation. It is stored hashed (SHA-256) in the database; the plaintext is unrecoverable. If a token is lost, issue a new one and revoke the old one.
