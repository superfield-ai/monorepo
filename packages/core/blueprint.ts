import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';

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
  | 'threat'
  | 'principle'
  | 'design_pattern'
  | 'architecture'
  | 'checklist'
  | 'antipattern';

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
  'arch',
  'auth',
  'data',
  'deploy',
  'env',
  'etl',
  'imap-etl',
  'process',
  'prune',
  'task-queue',
  'test',
  'ux',
  'worker',
];

/**
 * Loads the Superfield Blueprint from disk. Returns an indexed graph plus
 * all loaded domain rules.
 *
 * @param blueprintDir Absolute path to the `blueprint/` directory. Defaults
 *                     to `<cwd>/blueprint`.
 */
export async function loadBlueprint(blueprintDir?: string): Promise<Blueprint> {
  const dir = blueprintDir ?? path.resolve(process.cwd(), 'blueprint');
  const graphPath = path.join(dir, 'rules', 'graph.yaml');
  const rawGraph = await fs.readFile(graphPath, 'utf8');
  const graph = parseYaml(rawGraph, { uniqueKeys: false }) as {
    corpus_version: number;
    generated: string;
    rule_count: number;
    nodes: Record<string, [string, string, string, string, string]>;
  };

  const nodes: BlueprintGraphNode[] = Object.entries(graph.nodes).map(
    ([hash, tuple]) => ({
      hash,
      ruleId: tuple[0]!,
      name: tuple[1]!,
      type: tuple[2] as BlueprintRuleType,
      domain: tuple[3]!.toLowerCase(),
      sourceFile: tuple[4]!,
    }),
  );

  const domains = new Map<string, BlueprintDomain>();
  for (const domainName of KNOWN_DOMAINS) {
    const domainPath = path.join(dir, 'rules', 'blueprints', `${domainName}.yaml`);
    try {
      const rawDomain = await fs.readFile(domainPath, 'utf8');
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
        vision: parsed.meta?.vision ?? '',
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
  const text = `${input.title} ${input.body ?? ''} ${input.labels.join(' ')}`.toLowerCase();

  const KEYWORDS: Record<string, string[]> = {
    arch: ['architecture', 'module', 'package', 'dependency', 'monorepo', 'boundary', 'refactor'],
    auth: ['auth', 'login', 'session', 'token', 'credential', 'oauth', 'password', 'permission'],
    data: ['database', 'schema', 'migration', 'query', 'orm', 'model', 'table', 'index'],
    deploy: ['deploy', 'release', 'docker', 'ci/cd', 'kubernetes', 'rollout', 'artifact'],
    env: ['env var', 'environment', '.env', 'secret', 'config'],
    etl: ['etl', 'pipeline', 'transform', 'ingest', 'batch'],
    'imap-etl': ['imap', 'email ingest', 'mail fetch'],
    process: ['pr', 'pull request', 'issue', 'commit', 'workflow', 'ci', 'review', 'merge', 'plan'],
    prune: ['prune', 'cleanup', 'gc', 'garbage'],
    'task-queue': ['queue', 'worker', 'job', 'task'],
    test: ['test', 'spec', 'coverage', 'fixture', 'mock', 'msw', 'vitest'],
    ux: ['ui', 'ux', 'frontend', 'component', 'page', 'form', 'layout'],
    worker: ['worker', 'background', 'daemon', 'cron'],
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
