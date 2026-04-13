import { parseDeployPhase, runDeployCommand } from "@superfield/core";

const USAGE = "Usage: superfield deploy provision|deploy [target]";

export async function deployCommand(
  phase?: string,
  target?: string,
): Promise<void> {
  const parsedPhase = parseDeployPhase(phase);
  if (parsedPhase === null) {
    console.error(USAGE);
    process.exit(1);
    return;
  }

  await runDeployCommand({
    phase: parsedPhase,
    ...(target ? { target } : {}),
  });
}
