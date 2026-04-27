import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { BLUEPRINT_DATA } from "./blueprint-data.generated.ts";

/**
 * Loader for the Superfield Blueprint at `blueprint/rules/graph.yaml`
 * and its per-domain YAML files under `blueprint/rules/blueprints/`.
 *
 * The graph file uses a compact node format:
 *   nodes:
 *     <hash>: [rule_id, name, type, domain, source_file]
 *
 * Domain files carry full rule bodies:
 *   rules:
 *     - number: ARCH-T-001
 *       hash: 8a4c23247926
 *       name: server-code-in-browser-bundle
 *       type: threat
 *       description: ...
 *       deprecated: false
 */

export type BlueprintRuleType =
  | "threat"
  | "principle"
  | "design_pattern"
  | "architecture"
  | "checklist"
  | "antipattern"
  // "implementation" rules come from `blueprint/rules/implementations/ts/*.yaml`.
  // These are language-specific (TypeScript) concretions of the abstract
  // per-domain rules and are folded into their parent domain at load time so
  // that `pickCandidateDomains()` + domain-keyed lookups transparently surface
  // them alongside the rest of the rules. See issue #80 (narrow first-turn
  // context) for the primary consumer.
  | "implementation";

export interface BlueprintGraphNode {
  hash: string;
  ruleId: string;
  name: string;
  type: BlueprintRuleType;
  domain: string;
  sourceFile: string;
}

export interface BlueprintRule {
  number: string;
  hash: string;
  name: string;
  type: BlueprintRuleType;
  description: string;
  deprecated: boolean;
}

export interface BlueprintDomain {
  name: string;
  title: string;
  vision: string;
  rules: BlueprintRule[];
}

export interface Blueprint {
  corpusVersion: number;
  generated: string;
  ruleCount: number;
  nodes: BlueprintGraphNode[];
  domains: Map<string, BlueprintDomain>;
}

// Known blueprint domains. Used for the naive issue → domain heuristic.
const KNOWN_DOMAINS = [
  "arch",
  "auth",
  "data",
  "deploy",
  "env",
  "etl",
  "imap-etl",
  "process",
  "prune",
  "task-queue",
  "test",
  "ux",
  "worker",
];

/**
 * Pre-scans the raw graph.yaml text for duplicate keys inside the `nodes`
 * block. Used to surface upstream data quality issues that the YAML parser
 * would silently swallow under `uniqueKeys: false`.
 *
 * Returns the list of duplicated keys (each reported once, regardless of
 * how many times it appears).
 */
export function scanGraphForDuplicateKeys(rawYaml: string): string[] {
  const lines = rawYaml.split("\n");
  let inNodes = false;
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const line of lines) {
    if (/^nodes:\s*$/.test(line)) {
      inNodes = true;
      continue;
    }
    if (inNodes && /^\S/.test(line)) {
      // dedented to a new top-level key — out of nodes block
      inNodes = false;
      continue;
    }
    if (!inNodes) continue;

    // Match `  <key>: [...]` indented under nodes
    const match = /^\s+([0-9a-fA-F]+):/.exec(line);
    if (!match || match[1] === undefined) continue;
    const key = match[1];
    if (seen.has(key)) {
      duplicates.add(key);
    } else {
      seen.add(key);
    }
  }

  return [...duplicates];
}

let cached: Promise<Blueprint> | undefined;
let cachedSync: Blueprint | undefined;

/**
 * Clears the memoised singleton returned by `loadBlueprint()`. Intended for
 * tests; production code should not need this.
 */
export function resetBlueprintCache(): void {
  cached = undefined;
  cachedSync = undefined;
}

/**
 * Synchronous accessor for the bundled blueprint. Zero I/O, safe to call
 * during prompt assembly. Does not honour `SUPERFIELD_BLUEPRINT_DIR` — that
 * dev-only override is async-only.
 */
export function loadBlueprintSync(): Blueprint {
  if (!cachedSync) {
    cachedSync = buildFromBundled();
  }
  return cachedSync;
}

/**
 * Builds a `Blueprint` from the codegen'd `BLUEPRINT_DATA` constant. This is
 * the production path — it performs zero filesystem I/O, so the bundled
 * `superfield` binary can run without shipping a `blueprint/` asset dir.
 */
function buildFromBundled(): Blueprint {
  const domains = new Map<string, BlueprintDomain>();
  for (const d of BLUEPRINT_DATA.domains) {
    domains.set(d.name, {
      name: d.name,
      title: d.title,
      vision: d.vision,
      rules: d.rules.map((r) => ({
        number: r.number,
        hash: r.hash,
        name: r.name,
        type: r.type,
        description: r.description,
        deprecated: r.deprecated,
      })),
    });
  }
  // Fold implementation rules into their parent domain so lookups stay
  // domain-keyed. Filename convention: `<domain>-ts.yaml`. Parse the embedded
  // YAML body and append each rule (marked `type: implementation`) to the
  // matching domain's rules list.
  for (const [filename, body] of Object.entries(
    BLUEPRINT_DATA.implementations ?? {},
  )) {
    const domainName = filename.replace(/-ts\.ya?ml$/i, "").toLowerCase();
    const domain = domains.get(domainName);
    if (!domain) continue;
    try {
      const parsed = parseYaml(body) as {
        rules?: Array<{
          number: string;
          hash: string;
          name: string;
          type?: string;
          description: string;
          deprecated?: boolean;
        }>;
      };
      for (const r of parsed.rules ?? []) {
        domain.rules.push({
          number: r.number,
          hash: r.hash,
          name: r.name,
          type: "implementation",
          description: r.description,
          deprecated: r.deprecated ?? false,
        });
      }
    } catch {
      // Ignore malformed implementation files — this is codegen'd content and
      // a parse error here would be caught by the compile step, not runtime.
    }
  }
  return {
    corpusVersion: BLUEPRINT_DATA.corpusVersion,
    generated: BLUEPRINT_DATA.generated,
    ruleCount: BLUEPRINT_DATA.ruleCount,
    nodes: BLUEPRINT_DATA.nodes.map((n) => ({ ...n })),
    domains,
  };
}

/**
 * Loads the Superfield Blueprint. In production this is a zero-I/O call that
 * returns a cached singleton built from the codegen'd
 * `blueprint-data.generated.ts` module. The only remaining filesystem path is
 * the explicit `blueprintDir` argument (used by unit tests) or the
 * `SUPERFIELD_BLUEPRINT_DIR` environment variable (dev-only override).
 *
 * Pre-scans `graph.yaml` for duplicate keys and logs a warning per
 * collision when reading from disk. Set `SUPERFIELD_BLUEPRINT_STRICT=1` to
 * throw instead of warn.
 */
export async function loadBlueprint(blueprintDir?: string): Promise<Blueprint> {
  const envOverride = process.env.SUPERFIELD_BLUEPRINT_DIR;
  const dir =
    blueprintDir ?? (envOverride ? path.resolve(envOverride) : undefined);

  if (dir === undefined) {
    if (!cached) {
      cached = Promise.resolve(buildFromBundled());
    }
    return cached;
  }

  return loadBlueprintFromDisk(dir);
}

async function loadBlueprintFromDisk(dir: string): Promise<Blueprint> {
  const graphPath = path.join(dir, "rules", "graph.yaml");
  const rawGraph = await fs.readFile(graphPath, "utf8");

  // Surface collisions before they get silently swallowed by the YAML parser
  const duplicates = scanGraphForDuplicateKeys(rawGraph);
  if (duplicates.length > 0) {
    const message =
      `blueprint: ${duplicates.length} duplicate hash key(s) in ${graphPath}: ` +
      duplicates.join(", ");
    if (process.env.SUPERFIELD_BLUEPRINT_STRICT === "1") {
      throw new Error(message);
    }
    console.warn(`⚠ ${message}`);
    console.warn(
      "  This is a data quality issue in dot-matrix-labs/superfield-blueprint.",
    );
    console.warn(
      "  Last-write-wins is the current behaviour. File an upstream issue.",
    );
  }

  const graph = parseYaml(rawGraph, { uniqueKeys: false }) as {
    corpus_version: number;
    generated: string;
    rule_count: number;
    nodes: Record<string, [string, string, string, string, string]>;
  };

  const nodes: BlueprintGraphNode[] = Object.entries(graph.nodes).map(
    ([hash, tuple]) => ({
      hash,
      ruleId: tuple[0],
      name: tuple[1],
      type: tuple[2] as BlueprintRuleType,
      domain: tuple[3].toLowerCase(),
      sourceFile: tuple[4],
    }),
  );

  const domains = new Map<string, BlueprintDomain>();
  for (const domainName of KNOWN_DOMAINS) {
    const domainPath = path.join(
      dir,
      "rules",
      "blueprints",
      `${domainName}.yaml`,
    );
    try {
      const rawDomain = await fs.readFile(domainPath, "utf8");
      const parsed = parseYaml(rawDomain) as {
        meta?: { domain: string; title?: string; vision?: string };
        rules?: Array<{
          number: string;
          hash: string;
          name: string;
          type: BlueprintRuleType;
          description: string;
          deprecated?: boolean;
        }>;
      };
      domains.set(domainName, {
        name: domainName,
        title: parsed.meta?.title ?? domainName,
        vision: parsed.meta?.vision ?? "",
        rules: (parsed.rules ?? []).map((r) => ({
          number: r.number,
          hash: r.hash,
          name: r.name,
          type: r.type,
          description: r.description,
          deprecated: r.deprecated ?? false,
        })),
      });
    } catch {
      // Domain file missing — skip (e.g. if a subset of domains is bundled)
    }
  }

  return {
    corpusVersion: graph.corpus_version,
    generated: graph.generated,
    ruleCount: graph.rule_count,
    nodes,
    domains,
  };
}

/**
 * Naive heuristic: which blueprint domains are likely relevant to an issue
 * based on its title, body, and labels.
 *
 * Uses keyword matching for each known domain. Returns at most 4 candidate
 * domains sorted by match count. This is intentionally simple — the LLM
 * conformance step does the real evaluation.
 */
export function pickCandidateDomains(input: {
  title: string;
  body: string | null;
  labels: string[];
}): string[] {
  const text =
    `${input.title} ${input.body ?? ""} ${input.labels.join(" ")}`.toLowerCase();

  const KEYWORDS: Record<string, string[]> = {
    arch: [
      "architecture",
      "module",
      "package",
      "dependency",
      "monorepo",
      "boundary",
      "refactor",
    ],
    auth: [
      "auth",
      "login",
      "session",
      "token",
      "credential",
      "oauth",
      "password",
      "permission",
    ],
    data: [
      "database",
      "schema",
      "migration",
      "query",
      "orm",
      "model",
      "table",
      "index",
    ],
    deploy: [
      "deploy",
      "release",
      "docker",
      "ci/cd",
      "kubernetes",
      "rollout",
      "artifact",
    ],
    env: ["env var", "environment", ".env", "secret", "config"],
    etl: ["etl", "pipeline", "transform", "ingest", "batch"],
    "imap-etl": ["imap", "email ingest", "mail fetch"],
    process: [
      "pr",
      "pull request",
      "issue",
      "commit",
      "workflow",
      "ci",
      "review",
      "merge",
      "plan",
    ],
    prune: ["prune", "cleanup", "gc", "garbage"],
    "task-queue": ["queue", "worker", "job", "task"],
    test: ["test", "spec", "coverage", "fixture", "mock", "msw", "vitest"],
    ux: ["ui", "ux", "frontend", "component", "page", "form", "layout"],
    worker: ["worker", "background", "daemon", "cron"],
  };

  const scores: Array<{ domain: string; score: number }> = [];
  for (const [domain, keywords] of Object.entries(KEYWORDS)) {
    let score = 0;
    for (const kw of keywords) {
      if (text.includes(kw)) score++;
    }
    if (score > 0) scores.push({ domain, score });
  }

  scores.sort((a, b) => b.score - a.score);
  return scores.slice(0, 4).map((s) => s.domain);
}

/** Returns active (non-deprecated) rules of the given types from a domain. */
export function filterActiveRules(
  domain: BlueprintDomain,
  types: BlueprintRuleType[],
): BlueprintRule[] {
  return domain.rules.filter((r) => !r.deprecated && types.includes(r.type));
}
