/**
 * Build the pre-PR blueprint self-audit prompt sent to the agent after the
 * implementation turn but before opening a PR.
 *
 * Scout stub (issue #77) — returns the empty string. Real behaviour lands in
 * issue #82:
 *
 * - Gives the agent a diff summary and candidate domains.
 * - Asks for a structured verdict: `{ conformant: true }` or
 *   `{ conformant: false, violations: [...] }`.
 * - Dev-loop parses the verdict, progresses on conformant, loops back with
 *   remediation guidance on violations (capped at 3 remediation attempts).
 */
export function buildPrePRSelfAuditPrompt(ctx: {
  issueNumber: number;
  diffSummary: string;
  candidateDomains: string[];
}): string {
  void ctx;
  return "";
}
