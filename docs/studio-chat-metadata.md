# Studio Chat Metadata Storage

## Overview

Studio sessions produce structured chat metadata that is stored on the session
branch via **git notes**. This allows development agents to read back the full
conversation history — including user intent and outcomes — without polluting
the committed source tree.

## Storage mechanism

Git notes (`refs/notes/studio-chat`) are used to attach a JSON blob to the
latest commit on the session branch. Notes are a first-class git feature that:

- Do not appear as files in the working tree or committed source tree.
- Travel with `git push origin refs/notes/studio-chat` / `git fetch origin refs/notes/studio-chat:refs/notes/studio-chat`.
- Can be read back with `git notes --ref=studio-chat show <commit>`.

## Schema

The metadata blob is a single JSON object attached to the HEAD commit of the
session branch. It is updated after every turn.

```json
{
  "version": 1,
  "session": {
    "sessionId": "ab12",
    "startTime": "2026-03-25T10:00:00.000Z",
    "baseCommit": "abc1234def5678..."
  },
  "turns": [
    {
      "index": 0,
      "mode": "design",
      "userMessage": "Change the button color to blue",
      "assistantMessage": "I updated the button...",
      "timestamp": "2026-03-25T10:01:00.000Z",
      "checkpointCommit": "def5678"
    },
    {
      "index": 1,
      "mode": "question",
      "userMessage": "How does the auth flow work?",
      "assistantMessage": "The auth flow uses...",
      "timestamp": "2026-03-25T10:05:00.000Z",
      "checkpointCommit": null
    }
  ]
}
```

### Field reference

#### `session`

| Field        | Type   | Description                                      |
|-------------|--------|--------------------------------------------------|
| `sessionId` | string | The 4-character session identifier                |
| `startTime` | string | ISO 8601 timestamp when the session began         |
| `baseCommit`| string | Full commit hash of the main branch fork point    |

#### `turns[]`

| Field              | Type          | Description                                        |
|-------------------|---------------|----------------------------------------------------|
| `index`           | number        | Zero-based turn index                               |
| `mode`            | string        | `"design"` or `"question"`                          |
| `userMessage`     | string        | The user's message (sanitized)                      |
| `assistantMessage`| string        | Claude's response (sanitized)                       |
| `timestamp`       | string        | ISO 8601 timestamp of the turn                      |
| `checkpointCommit`| string\|null  | Abbreviated commit SHA if a checkpoint was created  |

## Sanitization

The following content is **excluded** from stored metadata:

- Internal reasoning / chain-of-thought
- Tool call data and function invocations
- Credentials, API keys, tokens
- Cluster runtime data (pod IPs, container IDs, etc.)

Messages are stored as plain text — the user's prompt and Claude's final
response only.

## Retrieval

Any agent that checks out or clones the session branch can retrieve the
metadata:

```bash
# Fetch the notes ref
git fetch origin refs/notes/studio-chat:refs/notes/studio-chat

# Read the metadata from HEAD
git notes --ref=studio-chat show HEAD
```

The output is valid JSON that can be piped to `jq` or parsed by any JSON
library.

## Push

After updating the metadata, studio pushes the notes ref alongside the branch:

```bash
git push origin refs/notes/studio-chat
```

## Integration

- `packages/core/chat-metadata.ts` — core module for reading, writing, and
  updating chat metadata.
- Called by the studio server after each turn completes.
- Depends on checkpoint-manager for commit SHA linkage.
