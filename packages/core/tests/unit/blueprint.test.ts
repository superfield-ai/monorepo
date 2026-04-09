import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import {
  loadBlueprint,
  pickCandidateDomains,
  filterActiveRules,
  scanGraphForDuplicateKeys,
} from "../../blueprint.ts";
import * as path from "node:path";

const BLUEPRINT_DIR = path.resolve(
  import.meta.dirname,
  "../../../../blueprint",
);

describe("loadBlueprint", () => {
  it("loads the bundled blueprint graph", async () => {
    const bp = await loadBlueprint(BLUEPRINT_DIR);
    expect(bp.corpusVersion).toBeGreaterThanOrEqual(1);
    expect(bp.ruleCount).toBeGreaterThan(100);
    expect(bp.nodes.length).toBeGreaterThan(100);
  });

  it("indexes nodes by rule id, name, type, domain", async () => {
    const bp = await loadBlueprint(BLUEPRINT_DIR);
    const archP001 = bp.nodes.find((n) => n.ruleId === "ARCH-P-001");
    expect(archP001).toBeDefined();
    expect(archP001?.type).toBe("principle");
    expect(archP001?.domain).toBe("arch");
    expect(archP001?.name).toBe("boundaries-are-physical-not-conceptual");
  });

  it("loads domain files with rule bodies", async () => {
    const bp = await loadBlueprint(BLUEPRINT_DIR);
    const arch = bp.domains.get("arch");
    expect(arch).toBeDefined();
    expect(arch!.rules.length).toBeGreaterThan(0);
    const rule = arch!.rules.find((r) => r.number === "ARCH-T-001");
    expect(rule).toBeDefined();
    expect(rule?.type).toBe("threat");
    expect(rule?.description).toMatch(/browser/i);
  });
});

describe("pickCandidateDomains", () => {
  it("picks arch for architecture-related issues", () => {
    const domains = pickCandidateDomains({
      title: "refactor: split module boundaries",
      body: "This issue is about the monorepo architecture and package boundaries.",
      labels: [],
    });
    expect(domains).toContain("arch");
  });

  it("picks auth for session/token issues", () => {
    const domains = pickCandidateDomains({
      title: "feat: add session token refresh",
      body: "OAuth flow needs to handle expired credentials.",
      labels: [],
    });
    expect(domains).toContain("auth");
  });

  it("picks test for coverage issues", () => {
    const domains = pickCandidateDomains({
      title: "fix: MSW fixture regression",
      body: "Unit test coverage dropped after vitest upgrade.",
      labels: [],
    });
    expect(domains).toContain("test");
  });

  it("returns empty array when no keywords match", () => {
    const domains = pickCandidateDomains({
      title: "foo",
      body: "bar",
      labels: [],
    });
    expect(domains).toEqual([]);
  });

  it("caps at 4 candidate domains", () => {
    const domains = pickCandidateDomains({
      title: "auth test worker architecture deploy env data task queue",
      body: "PR review workflow component UI ingest",
      labels: [],
    });
    expect(domains.length).toBeLessThanOrEqual(4);
  });
});

describe("scanGraphForDuplicateKeys", () => {
  it("returns an empty array when there are no duplicates", () => {
    const yaml = `nodes:
  abc: [A, B, C, D, E]
  def: [F, G, H, I, J]
`;
    expect(scanGraphForDuplicateKeys(yaml)).toEqual([]);
  });

  it("detects duplicate hash keys and returns each duplicated key", () => {
    const yaml = `nodes:
  abc: [A, B, C, D, E]
  def: [F, G, H, I, J]
  abc: [X, Y, Z, W, V]
`;
    const dups = scanGraphForDuplicateKeys(yaml);
    expect(dups).toContain("abc");
    expect(dups).not.toContain("def");
  });

  it("reports each duplicate only once even when it appears 3+ times", () => {
    const yaml = `nodes:
  abc: [a]
  abc: [b]
  abc: [c]
`;
    const dups = scanGraphForDuplicateKeys(yaml);
    expect(dups).toEqual(["abc"]);
  });

  it("only scans the nodes block — top-level duplicates outside nodes are not reported", () => {
    const yaml = `corpus_version: 1
nodes:
  abc: [a]
generated: x
`;
    expect(scanGraphForDuplicateKeys(yaml)).toEqual([]);
  });
});

describe("loadBlueprint — collision warnings", () => {
  let tmpDir: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "bp-test-"));
    await fs.mkdir(path.join(tmpDir, "rules", "blueprints"), {
      recursive: true,
    });
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    warnSpy.mockRestore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeGraph(content: string): Promise<void> {
    await fs.writeFile(path.join(tmpDir, "rules", "graph.yaml"), content);
  }

  it("warns once per duplicate key when graph has hash collisions", async () => {
    await writeGraph(`corpus_version: 1
generated: '2026-04-08'
rule_count: 2
nodes:
  abc: [TEST-T-001, dup-name-1, threat, ARCH, blueprints/arch]
  def: [TEST-T-002, unique-name, principle, ARCH, blueprints/arch]
  abc: [TEST-T-003, dup-name-2, threat, ARCH, blueprints/arch]
`);
    await loadBlueprint(tmpDir);
    const warnings = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(warnings.some((w) => w.includes("abc"))).toBe(true);
    expect(warnings.some((w) => w.toLowerCase().includes("duplicate"))).toBe(
      true,
    );
  });

  it("does not warn when there are no collisions", async () => {
    await writeGraph(`corpus_version: 1
generated: '2026-04-08'
rule_count: 1
nodes:
  abc: [TEST-T-001, unique-name, threat, ARCH, blueprints/arch]
`);
    await loadBlueprint(tmpDir);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("throws in strict mode (SUPERFIELD_BLUEPRINT_STRICT=1) when collisions exist", async () => {
    await writeGraph(`nodes:
  abc: [a, b, c, d, e]
  abc: [x, y, z, w, v]
`);
    process.env.SUPERFIELD_BLUEPRINT_STRICT = "1";
    try {
      await expect(loadBlueprint(tmpDir)).rejects.toThrow(/duplicate/i);
    } finally {
      delete process.env.SUPERFIELD_BLUEPRINT_STRICT;
    }
  });
});

describe("filterActiveRules", () => {
  it("excludes deprecated rules", async () => {
    const bp = await loadBlueprint(BLUEPRINT_DIR);
    const arch = bp.domains.get("arch")!;
    const threats = filterActiveRules(arch, ["threat"]);
    expect(threats.every((r) => !r.deprecated)).toBe(true);
    expect(threats.every((r) => r.type === "threat")).toBe(true);
  });

  it("filters by multiple types", async () => {
    const bp = await loadBlueprint(BLUEPRINT_DIR);
    const arch = bp.domains.get("arch")!;
    const rules = filterActiveRules(arch, ["threat", "antipattern"]);
    expect(
      rules.every((r) => r.type === "threat" || r.type === "antipattern"),
    ).toBe(true);
  });
});

describe("blueprint bundled module (scout)", () => {
  it.todo(
    "loadBlueprint returns singleton from bundled generated module (#78)",
  );
  it.todo("resetBlueprintCache forces reload (#78)");
});
