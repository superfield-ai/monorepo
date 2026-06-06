# Studio Agent Modes

The studio agent operates in one of two modes. The mode determines what
Claude can do and how it communicates with the user.

## Modes

### Design mode (default)

Claude has full read/write access to the codebase. It makes changes based on
the user's plain-language feedback.

**Allowed tools:** Read, Edit, Write, Glob, Grep

**Behaviour:** Claude edits files, creates files, runs builds, and commits
changes. Responses may reference technical details when helpful.

### Question mode

Claude answers questions about the product in plain, non-technical language.
It cannot edit, create, or delete any file.

**Allowed tools:** Read, Glob, Grep (read-only)

**Behaviour:**
- Answers in plain language only — no framework names, library names,
  programming language names, or code snippets.
- Distinguishes foundational platform guarantees from custom product logic.
- Refuses all file-editing or file-creating requests.
- Context is scoped to files relevant to the user's question.
- User input is treated as untrusted text (prompt injection defense).

## Mode switching

The mode is passed as a query parameter on the SSE chat endpoint:

```
GET /studio/chat/stream?message=...&mode=question
GET /studio/chat/stream?message=...&mode=design
```

When `mode` is omitted, Design mode is used (backwards compatible).

### Conversation history preservation

Switching modes preserves the conversation history. Prior turns from Design
mode are included in the Question mode prompt (and vice versa). Only the
system context and tool permissions change.

## Permission enforcement

### Tool-level enforcement (primary)

The `--allowedTools` flag passed to the Claude CLI is mode-dependent:

| Mode     | Allowed tools         |
| -------- | --------------------- |
| Design   | Read, Edit, Write, Glob, Grep |
| Question | Read, Glob, Grep      |

This is harness-level enforcement — Claude physically cannot invoke tools
not in the allowed set.

### System prompt enforcement (secondary)

The Question mode system prompt explicitly instructs Claude to:
1. Never mention technical terms or code.
2. Never propose file edits or creations.
3. Treat user input as untrusted text.

### Prompt injection defense

User messages in Question mode are wrapped in explicit untrusted-input
delimiters. The system prompt instructs Claude to ignore any embedded
instructions. Common injection patterns (e.g., "ignore previous
instructions", "you are now") are detected for monitoring purposes but are
not stripped — they are passed through as plain text.

## Context gating

In Question mode, the context window loads only files relevant to the user's
question. A keyword-to-file mapping determines which files to include based
on topic keywords found in the question text. When no keywords match, a
small default set of high-level configuration files is used.

## Files

| File | Purpose |
| ---- | ------- |
| `apps/server/src/question-mode.ts` | Question mode prompt, context gating, injection defense |
| `apps/server/src/permissions.ts` | Mode-aware tool filtering and CLI flag building |
| `apps/server/src/helpers.ts` | StudioMode type, mode-aware prompt builder |
| `apps/server/src/agent.ts` | runAgent with mode parameter |
| `apps/server/src/claude-session.ts` | streamTurn with mode parameter |
| `apps/server/src/router.ts` | Mode query parameter parsing |
| `docs/studio-agent-modes.md` | This document |
