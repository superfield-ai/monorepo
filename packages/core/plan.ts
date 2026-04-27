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

const SUPERFIELD_METADATA_RE = /<!--\s*superfield:\s*(\{.*?\})\s*-->/;
const ENTRY_RE = /^\s*-\s+#(\d+)\s+[—-]\s+(.+?)(?:\s+\[risk:\s*(\d+)\])?\s*$/;
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
      const metadataMatch =
        SUPERFIELD_METADATA_RE.exec(nextLine) ??
        SUPERFIELD_METADATA_RE.exec(nextLine);
      if (!metadataMatch) {
        // Orphan entry line without metadata — skip silently
        continue;
      }

      let metadata: Partial<PlanIssueMetadata>;
      try {
        metadata = JSON.parse(metadataMatch[1]!) as Partial<PlanIssueMetadata>;
      } catch {
        continue;
      }

      const issueNumber = Number(entryMatch[1]!);
      const lineTitle = entryMatch[2]!.trim();
      const riskFromLine = Number(entryMatch[3] ?? 3);
      const normalized: PlanIssueMetadata = {
        number:
          typeof metadata.number === "number" ? metadata.number : issueNumber,
        title:
          typeof metadata.title === "string" && metadata.title.trim().length > 0
            ? metadata.title
            : lineTitle,
        phase: typeof metadata.phase === "string" ? metadata.phase : "",
        kind:
          metadata.kind === "dev-scout" ||
          metadata.kind === "feature" ||
          metadata.kind === "ci-failure"
            ? metadata.kind
            : "feature",
        risk:
          typeof metadata.risk === "number" && Number.isFinite(metadata.risk)
            ? metadata.risk
            : riskFromLine,
        dependencies: Array.isArray(metadata.dependencies)
          ? metadata.dependencies.filter(
              (n): n is number => typeof n === "number" && Number.isFinite(n),
            )
          : [],
        parallel_safe:
          typeof metadata.parallel_safe === "boolean"
            ? metadata.parallel_safe
            : true,
      };

      if (currentPhase) {
        currentPhase.issues.push(normalized);
      } else {
        // No phase header seen yet — these are top-of-plan ci-failures
        if (normalized.kind === "ci-failure") {
          ciFailures.push(normalized);
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

// ── Plan validation ───────────────────────────────────────────────────────────

/** A structural violation found during plan validation. */
export interface ValidationError {
  message: string;
  issueNumber?: number;
  phaseName?: string;
}

/** Validates the Plan's ordering, scout structure, and phase dependency graph. */
export function validatePlan(plan: Plan): ValidationError[] {
  const errors: ValidationError[] = [];
  const flatIssues: Array<{ issue: PlanIssueMetadata; phaseName?: string }> = [
    ...plan.ciFailures.map((issue) => ({ issue })),
    ...plan.phases.flatMap((phase) =>
      phase.issues.map((issue) => ({ issue, phaseName: phase.name })),
    ),
  ];

  const firstSeenAt = new Map<number, number>();
  for (let index = 0; index < flatIssues.length; index++) {
    const { issue, phaseName } = flatIssues[index]!;
    if (firstSeenAt.has(issue.number)) {
      errors.push({
        message: `duplicate issue #${issue.number} appears multiple times in the Plan`,
        issueNumber: issue.number,
        phaseName,
      });
      continue;
    }
    firstSeenAt.set(issue.number, index);
  }

  for (let index = 0; index < flatIssues.length; index++) {
    const { issue, phaseName } = flatIssues[index]!;
    for (const dependency of issue.dependencies) {
      const dependencyIndex = firstSeenAt.get(dependency);
      if (dependencyIndex === undefined || dependencyIndex >= index) {
        errors.push({
          message: `issue #${issue.number} depends on #${dependency}, which does not appear earlier in plan order`,
          issueNumber: issue.number,
          phaseName,
        });
      }
    }
  }

  for (const phase of plan.phases) {
    const scouts = phase.issues.filter((issue) => issue.kind === "dev-scout");
    if (scouts.length !== 1) {
      errors.push({
        message:
          scouts.length === 0
            ? `phase "${phase.name}" has no dev-scout`
            : `phase "${phase.name}" has ${scouts.length} dev-scout issues (must be exactly 1)`,
        phaseName: phase.name,
      });
      continue;
    }
    if (phase.issues[0]?.kind !== "dev-scout") {
      errors.push({
        message: `phase "${phase.name}" scout is not first`,
        phaseName: phase.name,
      });
    }
  }

  const phaseNames = new Set(plan.phases.map((phase) => phase.name));
  const adjacency = new Map<string, string[]>();
  for (const phase of plan.phases) {
    adjacency.set(
      phase.name,
      phase.dependsOn.filter((dependsOn) => phaseNames.has(dependsOn)),
    );
  }
  if (hasPhaseCycle(adjacency)) {
    errors.push({ message: "phase dependency graph has a cycle" });
  }

  return errors;
}

function hasPhaseCycle(adjacency: Map<string, string[]>): boolean {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const colors = new Map<string, number>();
  for (const node of adjacency.keys()) colors.set(node, WHITE);

  function visit(node: string): boolean {
    colors.set(node, GRAY);
    for (const next of adjacency.get(node) ?? []) {
      const color = colors.get(next) ?? WHITE;
      if (color === GRAY) return true;
      if (color === WHITE && visit(next)) return true;
    }
    colors.set(node, BLACK);
    return false;
  }

  for (const node of adjacency.keys()) {
    if (colors.get(node) === WHITE && visit(node)) return true;
  }
  return false;
}
