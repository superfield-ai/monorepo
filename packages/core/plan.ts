/**
 * Parser and serializer for the Plan tracking issue body.
 *
 * The Plan is the orchestrator's view of ordered work. Its body has two
 * sections:
 *
 * 1. Top-of-plan ci-failure entries (no phase header, emitted first)
 * 2. Phase blocks, each with a header, goal, dependencies, scout gate,
 *    and ordered issue entries
 *
 * Each issue entry is a two-line block:
 *   - #<n> — <title> [risk: <1-6>]
 *     <!-- superfield: {"number":<n>,"phase":"...","kind":"...","dependencies":[...],"parallel_safe":true} -->
 *
 * The orchestrator reads metadata comments to drive the dev loop; humans
 * read the human-readable line.
 */

export type PlanIssueKind = "dev-scout" | "feature" | "ci-failure";

export interface PlanIssueMetadata {
  number: number;
  title: string;
  phase: string;
  kind: PlanIssueKind;
  risk: number;
  dependencies: number[];
  dependents?: number[];
  parallel_safe: boolean;
}

export interface PlanPhase {
  name: string;
  goal: string;
  dependsOn: string[];
  scoutGate: number | null;
  issues: PlanIssueMetadata[];
}

export interface Plan {
  /** CI failure entries at the top of the Plan, above all phase blocks. */
  ciFailures: PlanIssueMetadata[];
  phases: PlanPhase[];
}

const METADATA_RE = /<!--\s*superfield:\s*(\{.*?\})\s*-->/;
const ENTRY_RE = /^\s*-\s+#(\d+)\s+—\s+(.+?)\s+\[risk:\s*(\d+)\]\s*$/;
const PHASE_HEADER_RE = /^##\s+Phase:\s+(.+?)\s*$/;
const GOAL_RE = /^Goal:\s*(.*)$/;
const DEPENDS_ON_RE = /^Depends on phases:\s*(.*)$/;
const SCOUT_GATE_RE = /^Scout gate:\s*#(\d+)\s*$/;

/** Parses a Plan body into a structured Plan. */
export function parsePlan(body: string): Plan {
  const lines = body.split("\n");
  const ciFailures: PlanIssueMetadata[] = [];
  const phases: PlanPhase[] = [];
  let currentPhase: PlanPhase | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    const phaseMatch = PHASE_HEADER_RE.exec(line);
    if (phaseMatch) {
      if (currentPhase) phases.push(currentPhase);
      currentPhase = {
        name: phaseMatch[1]!,
        goal: "",
        dependsOn: [],
        scoutGate: null,
        issues: [],
      };
      continue;
    }

    if (currentPhase) {
      const goalMatch = GOAL_RE.exec(line);
      if (goalMatch) {
        currentPhase.goal = goalMatch[1]!;
        continue;
      }
      const depsMatch = DEPENDS_ON_RE.exec(line);
      if (depsMatch) {
        const v = depsMatch[1]!.trim();
        currentPhase.dependsOn =
          v && v !== "None." ? v.split(",").map((s) => s.trim()) : [];
        continue;
      }
      const scoutMatch = SCOUT_GATE_RE.exec(line);
      if (scoutMatch) {
        currentPhase.scoutGate = Number(scoutMatch[1]!);
        continue;
      }
    }

    const entryMatch = ENTRY_RE.exec(line);
    if (entryMatch) {
      const nextLine = lines[i + 1] ?? "";
      const metadataMatch = METADATA_RE.exec(nextLine);
      if (!metadataMatch) {
        // Orphan entry line without metadata — skip silently
        continue;
      }

      let metadata: PlanIssueMetadata;
      try {
        metadata = JSON.parse(metadataMatch[1]!) as PlanIssueMetadata;
      } catch {
        continue;
      }

      if (currentPhase) {
        currentPhase.issues.push(metadata);
      } else {
        // No phase header seen yet — these are top-of-plan ci-failures
        if (metadata.kind === "ci-failure") {
          ciFailures.push(metadata);
        }
      }
      i++; // skip the metadata line
    }
  }

  if (currentPhase) phases.push(currentPhase);

  return { ciFailures, phases };
}

/** Serializes a Plan back to markdown. */
export function serializePlan(plan: Plan): string {
  const parts: string[] = [];

  if (plan.ciFailures.length > 0) {
    parts.push(plan.ciFailures.map(renderEntry).join("\n"));
  }

  for (const phase of plan.phases) {
    const header: string[] = [`## Phase: ${phase.name}`, ""];
    header.push(`Goal: ${phase.goal}`);
    header.push(
      `Depends on phases: ${phase.dependsOn.length ? phase.dependsOn.join(", ") : "None."}`,
    );
    header.push(
      `Scout gate: ${phase.scoutGate === null ? "pending" : `#${phase.scoutGate}`}`,
    );
    header.push("");
    header.push(phase.issues.map(renderEntry).join("\n"));
    parts.push(header.join("\n"));
  }

  return parts.join("\n\n") + "\n";
}

function renderEntry(m: PlanIssueMetadata): string {
  const display = m.kind === "dev-scout" ? `[dev-scout] ${m.title}` : m.title;
  const line = `- #${m.number} — ${display} [risk: ${m.risk}]`;
  const metadata = `  <!-- superfield: ${JSON.stringify(m)} -->`;
  return `${line}\n${metadata}`;
}

/** Adds or replaces a ci-failure entry at the top of the Plan. Dedupe by issue number. */
export function insertCIFailureAtTop(
  plan: Plan,
  entry: PlanIssueMetadata,
): Plan {
  if (entry.kind !== "ci-failure") {
    throw new Error(
      `insertCIFailureAtTop: expected kind=ci-failure, got ${entry.kind}`,
    );
  }
  const filtered = plan.ciFailures.filter((e) => e.number !== entry.number);
  return { ...plan, ciFailures: [entry, ...filtered] };
}

/** Appends a feature/scout entry to a named phase, creating the phase if missing. */
export function appendToPhase(
  plan: Plan,
  phaseName: string,
  entry: PlanIssueMetadata,
): Plan {
  const phases = plan.phases.slice();
  const idx = phases.findIndex((p) => p.name === phaseName);
  if (idx < 0) {
    phases.push({
      name: phaseName,
      goal: "",
      dependsOn: [],
      scoutGate: null,
      issues: [entry],
    });
  } else {
    const existing = phases[idx]!;
    phases[idx] = { ...existing, issues: [...existing.issues, entry] };
  }
  return { ...plan, phases };
}

/** Returns true if the Plan already references the given issue number. */
export function planContainsIssue(plan: Plan, issueNumber: number): boolean {
  if (plan.ciFailures.some((e) => e.number === issueNumber)) return true;
  for (const phase of plan.phases) {
    if (phase.issues.some((e) => e.number === issueNumber)) return true;
  }
  return false;
}

/** Returns all issue numbers referenced in the Plan, in strict total order. */
export function planIssueOrder(plan: Plan): number[] {
  const order: number[] = [];
  for (const e of plan.ciFailures) order.push(e.number);
  for (const phase of plan.phases) {
    for (const e of phase.issues) order.push(e.number);
  }
  return order;
}
