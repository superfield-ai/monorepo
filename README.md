# Superfield

GitOps AI orchestrator. Git and GitHub are the control plane — issues are the task queue, the Plan issue is orchestration state, PRs are change proposals.

## Requirements

- [Bun](https://bun.sh) v1.3+
- A GitHub App authorization for the target user

## Install

```bash
bun install
```

Build and install the local CLI binary into `~/.bun/bin`:

```bash
bun run local-install
```

Make sure `~/.bun/bin` is on your `PATH`:

```bash
export PATH="$HOME/.bun/bin:$PATH"
```

## Setup

Sign in, then open the GitHub App install page:

```bash
bun run packages/cli/bin/superfield.ts github add
```

Remove a stored GitHub user:

```bash
bun run packages/cli/bin/superfield.ts github forget <handle>
```

Config is saved to `~/.superfield/config.yaml`.

## Run

Start the continuous loop — polls every 5 seconds, creates CI failure issues, and keeps the Plan issue up to date:

```bash
bun run start /path/to/repo [slotCount]
```

The path is required. Superfield reads the `origin` remote from the local git checkout to resolve `owner/repo`, then uses the matching user token from config.

Stop with Ctrl-C. The loop is stateless — restarting picks up where GitHub left off.

## Development

```bash
# Typecheck
bun run typecheck

# Unit tests
bun --bun vitest run packages/*/tests/unit

# Integration tests
bun --bun vitest run packages/*/tests/integration

# All tests
bun run test
```

## Structure

```
packages/
  cli/      Commands: github add, github forget, start, plan, feature
  core/     Config, outer loop, CI watchdog
  github/   Octokit wrapper (GitHub API client)
  git/      isomorphic-git wrapper (no git binary)
tests/
  fixtures/ Golden API response fixtures for MSW
docs/
  prd.md    Product requirements
  plan.md   Implementation plan
```
