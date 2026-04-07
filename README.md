# Superfield

GitOps AI orchestrator. Git and GitHub are the control plane — issues are the task queue, the Plan issue is orchestration state, PRs are change proposals.

## Requirements

- [Bun](https://bun.sh) v1.3+
- A GitHub Personal Access Token with `repo` and `workflow` scopes

## Install

```bash
bun install
```

## Setup

Add a GitHub user:

```bash
bun run packages/cli/bin/superfield.ts setup
```

Register a repository and assign it to a user:

```bash
bun run packages/cli/bin/superfield.ts repo add
```

Config is saved to `~/.superfield/config.yaml`.

## Run

Start the continuous loop — polls every 5 seconds, creates CI failure issues, and keeps the Plan issue up to date:

```bash
bun run start /path/to/repo
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
  cli/      Commands: setup, repo add, start
  core/     Config, outer loop, CI watchdog
  github/   Octokit wrapper (GitHub API client)
  git/      isomorphic-git wrapper (no git binary)
tests/
  fixtures/ Golden API response fixtures for MSW
docs/
  prd.md    Product requirements
  plan.md   Implementation plan
```
