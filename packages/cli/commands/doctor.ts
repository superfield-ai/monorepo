import { doctor, renderDoctorReport } from "@superfield/core";

const USAGE = `Usage: superfield doctor --env <e> [--repo <owner/name>] [--backend <b>] [--json]

Options:
  --env <e>           Environment slug (e.g. staging, prod)  [required]
  --repo <owner/name> GitHub repository (default: inferred from git remote)
  --backend <b>       Deployment runtime to verify: fastenv (default) | k3s
  --json              Output structured JSON instead of a table`;

export type DeployBackend = "fastenv" | "k3s";

export interface ParsedDoctorArgs {
  env?: string;
  repo?: string;
  backend?: DeployBackend;
  json: boolean;
  unknown: string[];
}

export function parseDoctorArgs(args: string[]): ParsedDoctorArgs {
  const out: ParsedDoctorArgs = { json: false, unknown: [] };
  let i = 0;
  const setBackend = (v: string | undefined) => {
    if (v === "fastenv" || v === "k3s") out.backend = v;
    else if (v !== undefined) out.unknown.push(`--backend ${v}`);
  };
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
    else if (a === "--backend") setBackend(take());
    else if ((v = eq("--backend=")) !== undefined) setBackend(v);
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
    ...(parsed.backend ? { backend: parsed.backend } : {}),
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
