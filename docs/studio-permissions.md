# Studio Permission Sandbox

Studio mode restricts Claude's tool access so non-technical users cannot
accidentally trigger destructive operations. The permission boundary is
enforced by the studio harness, not by prompt instructions alone.

## Permission model

### Allowed

| Operation              | Tool / Mechanism                    |
| ---------------------- | ----------------------------------- |
| Read files             | `Read`, `Glob`, `Grep`             |
| Edit files             | `Edit`, `Write`                     |
| Trigger rebuild        | `POST /studio/rebuild` endpoint     |

### Denied

| Operation              | Examples                            |
| ---------------------- | ----------------------------------- |
| Git commands           | `git`, `gh`                         |
| File deletion          | `rm`, `rmdir`, `unlink`             |
| Package managers       | `npm`, `yarn`, `pnpm`, `bun install/add/remove` |
| Outbound HTTP          | `curl`, `wget`, `ssh`, `nc`         |
| System utilities       | `sudo`, `docker`, `kubectl`, `chmod`, `kill` |

## Enforcement mechanism

The harness enforces permissions at two levels:

### 1. Tool filtering (primary)

The `--allowedTools` flag is passed to the Claude CLI invocation, physically
restricting which tools Claude can see or invoke. The allowed set is:

```
Read,Edit,Write,Glob,Grep
```

The `Bash` tool is intentionally excluded. Claude cannot run arbitrary shell
commands in studio mode.

This is implemented in `apps/server/src/permissions.ts` and integrated into
the Claude CLI spawn in `apps/server/src/claude-session.ts` (streamTurn) and
`apps/server/src/agent.ts` (runAgent).

### 2. Bash command validation (defense-in-depth)

If a Bash command somehow reaches the harness (e.g. through a future tool
that wraps Bash), the `validateBashCommand()` function checks the command
against a deny-list of dangerous binaries and patterns. This is a
defense-in-depth layer, not the primary enforcement.

### 3. System prompt addendum (secondary)

A permission-aware addendum is available for the studio system prompt. This
ensures Claude is aware of the restrictions and can communicate them to the
user. It is a secondary safeguard; the primary enforcement is harness-level.

## Denial behaviour

When Claude attempts a forbidden action:

1. The `--allowedTools` flag prevents the tool from appearing in Claude's
   available tool list, so the model cannot invoke it.
2. If a denial is detected at the Bash validation layer, the harness returns
   a clear, non-silent denial message via `buildPermissionDeniedMessage()`.
3. The denial message explains what was blocked and why, so Claude can
   suggest an alternative approach.

## Files

| File                                                  | Purpose                                |
| ----------------------------------------------------- | -------------------------------------- |
| `apps/server/src/permissions.ts`                      | Allow/deny lists, tool filtering, Bash validation |
| `apps/server/src/claude-session.ts`                   | streamTurn integration (--allowedTools flag) |
| `apps/server/src/agent.ts`                            | runAgent integration (--allowedTools flag) |
| `apps/server/tests/unit/permissions.test.ts`          | Unit tests for tool filtering and Bash validation |
| `apps/server/tests/integration/permissions.test.ts`   | Integration tests for end-to-end enforcement |
| `docs/studio-permissions.md`                          | This document                          |

## Integration with session lifecycle

The permission sandbox activates whenever Claude is invoked in studio mode.
Both `streamTurn()` (SSE endpoint) and `runAgent()` (direct invocation)
apply the `--allowedTools` restriction. The permission model is stateless
and does not depend on session or worktree lifecycle.
