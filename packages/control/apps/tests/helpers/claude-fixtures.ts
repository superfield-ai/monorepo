export interface ClaudeFixture {
  sessionId: string;
  output: string;
  isError?: boolean;
  costUsd?: number;
  needsBlueprintEscalation?: boolean;
}

const FIXTURES: Record<string, ClaudeFixture> = {
  "dev-loop-first-turn": {
    sessionId: "01JDEVTURN10000000000",
    output:
      '{"status":"working","notes":"wrote outermost failing test against narrow blueprint context"}',
    isError: false,
    costUsd: 0.012,
    needsBlueprintEscalation: true,
  },
};

export function loadClaudeFixture(name: string): ClaudeFixture {
  const fixture = FIXTURES[name];
  if (!fixture) {
    throw new Error(`Unknown Claude fixture: ${name}`);
  }
  return fixture;
}

export function loadClaudeOutput(name: string): string {
  return loadClaudeFixture(name).output;
}
