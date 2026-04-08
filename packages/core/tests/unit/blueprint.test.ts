import { describe, it, expect } from 'vitest';
import { loadBlueprint, pickCandidateDomains, filterActiveRules } from '../../blueprint.ts';
import * as path from 'node:path';

const BLUEPRINT_DIR = path.resolve(import.meta.dirname, '../../../../blueprint');

describe('loadBlueprint', () => {
  it('loads the bundled blueprint graph', async () => {
    const bp = await loadBlueprint(BLUEPRINT_DIR);
    expect(bp.corpusVersion).toBeGreaterThanOrEqual(1);
    expect(bp.ruleCount).toBeGreaterThan(100);
    expect(bp.nodes.length).toBeGreaterThan(100);
  });

  it('indexes nodes by rule id, name, type, domain', async () => {
    const bp = await loadBlueprint(BLUEPRINT_DIR);
    const archP001 = bp.nodes.find((n) => n.ruleId === 'ARCH-P-001');
    expect(archP001).toBeDefined();
    expect(archP001?.type).toBe('principle');
    expect(archP001?.domain).toBe('arch');
    expect(archP001?.name).toBe('boundaries-are-physical-not-conceptual');
  });

  it('loads domain files with rule bodies', async () => {
    const bp = await loadBlueprint(BLUEPRINT_DIR);
    const arch = bp.domains.get('arch');
    expect(arch).toBeDefined();
    expect(arch!.rules.length).toBeGreaterThan(0);
    const rule = arch!.rules.find((r) => r.number === 'ARCH-T-001');
    expect(rule).toBeDefined();
    expect(rule?.type).toBe('threat');
    expect(rule?.description).toMatch(/browser/i);
  });
});

describe('pickCandidateDomains', () => {
  it('picks arch for architecture-related issues', () => {
    const domains = pickCandidateDomains({
      title: 'refactor: split module boundaries',
      body: 'This issue is about the monorepo architecture and package boundaries.',
      labels: [],
    });
    expect(domains).toContain('arch');
  });

  it('picks auth for session/token issues', () => {
    const domains = pickCandidateDomains({
      title: 'feat: add session token refresh',
      body: 'OAuth flow needs to handle expired credentials.',
      labels: [],
    });
    expect(domains).toContain('auth');
  });

  it('picks test for coverage issues', () => {
    const domains = pickCandidateDomains({
      title: 'fix: MSW fixture regression',
      body: 'Unit test coverage dropped after vitest upgrade.',
      labels: [],
    });
    expect(domains).toContain('test');
  });

  it('returns empty array when no keywords match', () => {
    const domains = pickCandidateDomains({
      title: 'foo',
      body: 'bar',
      labels: [],
    });
    expect(domains).toEqual([]);
  });

  it('caps at 4 candidate domains', () => {
    const domains = pickCandidateDomains({
      title: 'auth test worker architecture deploy env data task queue',
      body: 'PR review workflow component UI ingest',
      labels: [],
    });
    expect(domains.length).toBeLessThanOrEqual(4);
  });
});

describe('filterActiveRules', () => {
  it('excludes deprecated rules', async () => {
    const bp = await loadBlueprint(BLUEPRINT_DIR);
    const arch = bp.domains.get('arch')!;
    const threats = filterActiveRules(arch, ['threat']);
    expect(threats.every((r) => !r.deprecated)).toBe(true);
    expect(threats.every((r) => r.type === 'threat')).toBe(true);
  });

  it('filters by multiple types', async () => {
    const bp = await loadBlueprint(BLUEPRINT_DIR);
    const arch = bp.domains.get('arch')!;
    const rules = filterActiveRules(arch, ['threat', 'antipattern']);
    expect(rules.every((r) => r.type === 'threat' || r.type === 'antipattern')).toBe(true);
  });
});
