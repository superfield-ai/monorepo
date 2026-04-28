import { doctor, renderDoctorReport } from "@superfield/core";

const USAGE = `Usage: superfield doctor --env <e> [--repo <owner/name>] [--json]

Options:
  --env <e>           Environment slug (e.g. staging, prod)  [required]
  --repo <owner/name> GitHub repository (default: inferred from git remote)
  --json              Output structured JSON instead of a table`;

export interface ParsedDoctorArgs {
  env?: string;
  repo?: string;
  json: boolean;
  unknown: string[];
}

export function parseDoctorArgs(args: string[]): ParsedDoctorArgs {
  const out: ParsedDoctorArgs = { json: false, unknown: [] };
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (a === undefined) {
      i++;
      continue;
    }
    const take = (): string | undefined => args[++i];
    const eq = (prefix: string): string | undefined =>
      a.startsWith(prefix) ? a.slice(prefix.length) : undefined;
    let v: string | undefined;

    if (a === "--env") out.env = take();
    else if ((v = eq("--env=")) !== undefined) out.env = v;
    else if (a === "--repo") out.repo = take();
    else if ((v = eq("--repo=")) !== undefined) out.repo = v;
    else if (a === "--json") out.json = true;
    else out.unknown.push(a);

    i++;
  }
  return out;
}

export async function doctorCommand(args: string[]): Promise<void> {
  const parsed = parseDoctorArgs(args);

  if (!parsed.env) {
    console.error("[error] --env is required");
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  if (!parsed.repo) {
    console.error("[error] --repo is required");
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  if (parsed.unknown.length > 0) {
    console.error(`[error] Unknown arguments: ${parsed.unknown.join(" ")}`);
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  const report = await doctor({
    repo: parsed.repo,
    env: parsed.env,
    json: parsed.json,
  });

  if (parsed.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderDoctorReport(report));
  }

  if (!report.allOk) {
    process.exitCode = 1;
  }
}
