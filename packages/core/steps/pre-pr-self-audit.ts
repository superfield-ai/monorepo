/**
 * Dev-loop stage: run the pre-PR blueprint self-audit.
 *
 * Scout stub (issue #77) — always returns a conformant verdict with no
 * violations. Real wiring into the dev-loop (remediation loop, 3-attempt cap,
 * escalation interaction) lands in issue #82.
 */

export interface PrePRSelfAuditViolation {
  ruleId: string;
  ruleName: string;
  domain: string;
  concern: string;
}

export type PrePRSelfAuditResult =
  | { conformant: true; violations: [] }
  | { conformant: false; violations: PrePRSelfAuditViolation[] };

export interface PrePRSelfAuditOpts {
  issueNumber: number;
  diffSummary: string;
  candidateDomains: string[];
}

export async function runPrePRSelfAudit(
  opts: PrePRSelfAuditOpts,
): Promise<PrePRSelfAuditResult> {
  void opts;
  return { conformant: true as const, violations: [] };
}
