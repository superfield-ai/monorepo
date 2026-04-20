# Distroless container for the superfield CLI.
#
# The binary is built outside the image with `bun build --compile`. The image
# only carries the resulting static binary; no Bun runtime, no shell, no
# package manager. See `.github/workflows/container-build.yml` for the CI
# build path.
#
# Multi-arch: pre-build both `dist/superfield-linux-amd64` and
# `dist/superfield-linux-arm64`, then `docker buildx build --platform
# linux/amd64,linux/arm64 packages/cli`. Buildx sets `TARGETARCH` per
# platform so the matching binary is selected.

# Bun's `--compile` output is a dynamically-linked ELF that depends on
# glibc + libpthread + libdl + libm + libstdc++. distroless/base ships
# exactly those (and nothing else), so it is the smallest distroless image
# that can run a Bun-compiled binary. distroless/static is glibc-less and
# therefore cannot.
FROM gcr.io/distroless/base-debian12:nonroot

ARG TARGETARCH
COPY dist/superfield-linux-${TARGETARCH} /superfield

USER nonroot
ENTRYPOINT ["/superfield"]
