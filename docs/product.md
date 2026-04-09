# Superfield — Product Requirements Document

This file is the product-facing scope: what Superfield is, who it's for, what it does for the user, and what's out of scope. Implementation details live in [`architecture.md`](./architecture.md); build order lives in [`roadmap.md`](./roadmap.md); test strategy lives in [`testing.md`](./testing.md).

## Overview

Superfield is an opinionated GitOps AI orchestrator. Git and the forge (GitHub initially) are the control plane — not a side effect. Issues are the task queue. The Plan issue is orchestration state. PRs are change proposals. Superfield reads from and writes to this control plane to drive autonomous development loops.

It replaces calypso-agents entirely, re-encoding every skill and workflow as TypeScript. Hard type contracts and deterministic code replace the soft guardrails of hand-authored markdown skill files and shell scripts. Prompts to the LLM still exist, but they are generated from typed TypeScript builders, not loose markdown on disk. The result is a self-contained, testable runtime that treats the forge as the single source of truth for all agent state.

## Problem

The calypso-agents skill system requires a human (or LLM session) to interpret and direct execution. For autonomous continuous loops this model is too fragile: drift, misinterpretation, and context loss compound over time. Shell scripts add a second failure surface — they depend on system binaries, environment state, and implicit PATH. Superfield eliminates both: skills become typed TypeScript modules, all external interaction goes through direct API calls, and the forge owns all state.

## Guiding Principles

- **Forge as control plane.** Git and GitHub are the source of truth for all agent state, task ordering, and communication.
- **No customization.** There are no workflow flags or configuration knobs. Superfield encodes one correct way to do things.
- **No system binaries.** Never shell out to `git`, `gh`, `curl`, or any other system executable. All git operations go through a TypeScript git library; all GitHub operations go through a TypeScript GitHub API client. The sole exception is agent vendor CLIs (e.g. `claude`, `codex`) — these are spawned as subprocesses because they are the LLM execution layer, not system utilities.
- **Skills are code.** Each calypso-agents skill is a TypeScript module with an explicit interface, typed inputs/outputs, and unit tests.
- **API-first testing.** Both the git library and the GitHub client are tested extensively via MSW-intercepted API calls and golden response fixtures.

## CLI Commands

Superfield has exactly three operational commands plus github subcommands. There are no flags to modify their behavior.

```
superfield github add       # authenticate, install app, and register the current repo
superfield github forget    # remove credentials and print the app uninstall link

superfield start [slotCount]  # begin the continuous development loop (foreground)
superfield plan             # sync all open issues into the Plan tracking issue
superfield feature          # ticket a new feature issue and update the Plan
```

**`superfield start`** runs a continuous loop with three concurrent responsibilities: keeping the Plan healthy (CI watchdog, issue audit, blueprint conformance), driving issues through development and merge, and keeping documentation in sync on every merge. See [`architecture.md`](./architecture.md#command-start-internals) for details.

**`superfield plan`** is a one-shot replan that audits open issues, groups them into phases, and writes the Plan tracking issue. Safe to run while `start` is active. See [`architecture.md`](./architecture.md#command-plan-internals).

**`superfield feature`** tickets a new feature issue and registers it in the Plan. Safe to run while `start` is active. See [`architecture.md`](./architecture.md#command-feature-internals).

### Concurrency model

`start` can be running in one terminal while `plan` or `feature` is invoked in another. There is no local IPC or shared process state. Coordination happens through the forge: `plan` and `feature` write to GitHub; `start` picks up their changes on the next poll cycle. This is a direct consequence of the forge-as-control-plane design.

---

## Out of Scope (entire roadmap)

- Slack / webhook notifications
- Web UI
- Forges other than GitHub
- Self-hosted LLM backends (Claude and Codex CLIs are supported)

---

## Open Questions

1. **Plan issue ownership**: always created under `assignedUser`'s token, or is there ever a separate service account concept?
