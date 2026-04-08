# Codex fixtures

Recorded `codex exec --json` responses, replayed by the Codex fixture helper
in integration tests. See `docs/testing.md` for the full strategy.

## Format

Each fixture is raw JSONL emitted by `codex exec --json`. The replay helper
parses the `thread.started` event for the session ID and the final
`item.completed` agent message as output.

## Recording

Use the Codex fixture recorder to refresh these files. Never edit them by
hand.
