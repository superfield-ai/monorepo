# Implementation Plan — Initial Scaffold

- Init TypeScript monorepo: `packages/cli`, `packages/core`, `packages/github`, `packages/git`
- Wire CLI entrypoint (`superfield setup`, `superfield repo add`, `superfield start` stub)
- Implement config read/write (`~/.superfield/config.yaml`)
- Add `@octokit/rest` client wrapper in `packages/github` with MSW test harness
- Add `isomorphic-git` wrapper in `packages/git` with MSW test harness
- Record golden fixtures for GitHub Check Runs and Issues endpoints
- Implement outer loop: CI watchdog → create `ci-failure` issue → update Plan
