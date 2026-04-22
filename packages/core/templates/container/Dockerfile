# Distroless container template for Bun-compiled binaries.
#
# Pattern: TypeScript packages compile to standalone native binaries via
# `bun build --compile --target=bun-linux-<arch>`. The resulting static
# binary is `COPY`d into a distroless/static image. No Bun runtime, no
# shell, no package manager, no source.
#
# Usage:
#   1. Pre-build dist/<name>-linux-amd64 and dist/<name>-linux-arm64 with
#      `bun build --compile`.
#   2. Replace `<name>` placeholders below with the binary name.
#   3. `docker buildx build --platform linux/amd64,linux/arm64 .`

# Bun's `--compile` output is a dynamically-linked ELF that depends on
# glibc + libpthread + libdl + libm + libstdc++. distroless/base ships
# exactly those (and nothing else), so it is the smallest distroless image
# that can run a Bun-compiled binary. distroless/static cannot.
FROM gcr.io/distroless/base-debian12:nonroot

ARG TARGETARCH
COPY dist/<name>-linux-${TARGETARCH} /<name>

USER nonroot
ENTRYPOINT ["/<name>"]
