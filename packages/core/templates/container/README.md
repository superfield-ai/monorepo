# Container templates

Vendored templates for shipping Bun-compiled TypeScript binaries as distroless
container images. See `deploy-features.md` § Design Principles ("Bun
executables") for the rationale.

## Files

- `Dockerfile` — distroless/static base, `COPY`s a pre-built static binary,
  multi-arch via `TARGETARCH`.
- `.dockerignore` — restricts the build context to the pre-built binaries.
- `container-build.yml` — GitHub Actions workflow that compiles the binary
  with `bun build --compile` and builds (and on tag pushes, pushes) a
  multi-arch image to GHCR.

## Placeholders

Each file contains `<name>` placeholders that should be replaced with the
binary name when the templates are rendered into a target repo (e.g.
`superfield`, `worker`).

## Conventions

- Binaries land in `packages/<name>/dist/<name>-linux-amd64` and
  `packages/<name>/dist/<name>-linux-arm64`.
- The binary package's `package.json` exposes:
  - `build:compile` → amd64 only (fast local default)
  - `build:compile:arm64` → arm64 only
  - `build:compile:all` → both
- Image tags published from CI: `sha-<commit>` always, plus the semver tag
  (`v*`) on tag pushes. `latest` is never published — image tags are
  immutable.

## Reference implementation

`packages/cli/` in this repo uses these templates verbatim (with `<name>`
resolved to `superfield`).
