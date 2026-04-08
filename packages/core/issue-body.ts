/**
 * Renders and parses the unified `IssueBody` schema. The schema follows
 * the section names prescribed by the Superfield Blueprint:
 *   ## Phase
 *   ## Motivation
 *   ## Canonical docs
 *   ## Features
 *   ## Test Plan
 *
 * Used by `plan` (to create scout issues) and `feature` (to create feature
 * issues). Issue classification (kind) lives on labels, not in the body.
 */
export interface IssueBody {
  title: string;
  phase: string;
  motivation: string;
  features: string[];
  test_plan: string[];
  canonical_docs: string[];
}

/** Renders an IssueBody to the markdown body GitHub stores. */
export function renderIssueBody(body: IssueBody): string {
  const lines: string[] = [];

  lines.push('## Phase');
  lines.push(body.phase);
  lines.push('');

  lines.push('## Motivation');
  lines.push(body.motivation);
  lines.push('');

  lines.push('## Canonical docs');
  if (body.canonical_docs.length === 0) {
    lines.push('- (none)');
  } else {
    for (const doc of body.canonical_docs) {
      lines.push(`- ${doc}`);
    }
  }
  lines.push('');

  lines.push('## Features');
  if (body.features.length === 0) {
    lines.push('- [ ] TBD');
  } else {
    for (const feature of body.features) {
      lines.push(`- [ ] ${feature}`);
    }
  }
  lines.push('');

  lines.push('## Test Plan');
  if (body.test_plan.length === 0) {
    lines.push('- [ ] TBD');
  } else {
    for (const test of body.test_plan) {
      lines.push(`- [ ] ${test}`);
    }
  }

  return lines.join('\n');
}

/** Returns true if the body string contains all required IssueBody sections. */
export function isConformantBody(body: string): boolean {
  return (
    body.includes('## Phase') &&
    body.includes('## Motivation') &&
    body.includes('## Canonical docs') &&
    body.includes('## Features') &&
    body.includes('## Test Plan')
  );
}
