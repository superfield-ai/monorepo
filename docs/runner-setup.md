# GitHub Actions Self-Hosted Runner Setup

This guide explains how to register the GCP VM provisioned by `superfield deploy gcp` as a GitHub Actions self-hosted runner for this repository.

## Prerequisites

- A GCP VM provisioned via `superfield deploy gcp` (the bootstrap script installs Docker, k3s, kubectl, and Bun).
- SSH access to the VM with sudo rights.
- Owner or Admin access to the GitHub repository (needed to generate a runner token).

## 1. Get a Runner Token

1. Go to **Settings → Actions → Runners** in the GitHub repository.
2. Click **New self-hosted runner**.
3. Select **Linux** / **x64**.
4. Copy the token shown in the `--token` argument of the `config.sh` command on that page.

## 2. Download and Configure the Runner

SSH into the VM, then run:

```bash
mkdir -p ~/actions-runner && cd ~/actions-runner
curl -O -L https://github.com/actions/runner/releases/download/v2.317.0/actions-runner-linux-x64-2.317.0.tar.gz
tar xzf ./actions-runner-linux-x64-2.317.0.tar.gz
./config.sh \
  --url https://github.com/superfield-ai/monorepo \
  --token <RUNNER_TOKEN> \
  --labels self-hosted,linux,x64 \
  --unattended
```

Replace `<RUNNER_TOKEN>` with the token you copied in step 1.

## 3. Install as a systemd Service

```bash
sudo ./svc.sh install
sudo ./svc.sh start
sudo ./svc.sh status
```

The service runs as the current user and starts automatically on reboot.

## 4. Verify

Go to **Settings → Actions → Runners** in the GitHub repository. The runner should appear with status **Idle**.

## 5. Pre-installed Tools on the Runner

The following tools are expected to be present on the runner (installed by the `superfield deploy gcp` bootstrap script):

- **Bun** — JavaScript/TypeScript runtime and package manager (replaces the `oven-sh/setup-bun` GitHub Action step)
- **Docker** — container runtime (used by `test-bootstrap` and `test-e2e` workflows)
- **kubectl** — Kubernetes CLI
- **k3s** — lightweight Kubernetes distribution (used by the bootstrap smoke test)

Because Bun is pre-installed, all workflows omit the `oven-sh/setup-bun@v2` setup step and go straight to `bun install --frozen-lockfile`.

## 6. Unregistering the Runner

To remove the runner from the repository:

```bash
cd ~/actions-runner
./config.sh remove --token <RUNNER_TOKEN>
```

Get a fresh removal token from **Settings → Actions → Runners → your runner → Remove**.

Optionally stop and uninstall the systemd service first:

```bash
sudo ./svc.sh stop
sudo ./svc.sh uninstall
```
