# Runner: replay (Tier 1)

> The cheap engine: instead of driving the live loop, it **replays a recorded
> episode trace** and runs graders over the stored artifacts. No model call, no
> appliance boot. Spec only — code lands later in `crates/sf-eval`.

## Why it exists

Every live run records an episode trace (`sharp.episodes` +
`sharp.episode_typed_artifacts`: `prompt`, `context`, `tool_call`, `validation`,
`judge`). The replay runner reads that trace and scores a **single step's
output** against a grader's rubric — the fast regression net that catches
prompt/harness drift without paying for a live run.

## What it does

1. Take an episode id (or a recorded fixture under the scenario).
2. Load the relevant artifacts from the Sharp episode store.
3. Run the chosen grader(s) against them — e.g. did `ArchitectureProposal`
   respect the Blueprint rules it was handed? did `ProjectGraphDerive` emit a
   well-formed graph?
4. Emit a pass/fail with the grader's reasoning.

## Relationship to the live runner

Same **scenarios** and same **graders**, different engine: `live` produces fresh
traces against a real model; `replay` re-grades stored traces deterministically.
A scenario doesn't know or care which runner drove it.

## Status

Lowest-cost tier, but second to build — the first signal we want is end-to-end
(`live`). This spec reserves the shape so graders are written runner-agnostic
from day one.
