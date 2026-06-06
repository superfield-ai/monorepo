#!/usr/bin/env bun
/**
 * Sharp client CLI.
 *
 * v1 surface for operators and humans driving Sharp manually. The full
 * Git-shaped CLI (init/clone/add/commit/branch/checkout/pull/push) is
 * exposed by this dispatcher; it delegates to the library functions in
 * @sharp/client.
 *
 * Configuration:
 *   SHARP_URL    Sharp server base URL (e.g. http://localhost:5174)
 *   SHARP_TOKEN  Bearer token issued via `sharp admin issue-token`
 *   SHARP_REPO   Default repo name (per-command override via --repo)
 */
import { SharpClient } from './http';
import { startPostgres } from '../../../tests/harness/pg-container';
import { startServer } from '../../server/src/server';
import { issueToken } from '../../server/src/auth';

interface CliOpts {
  url: string;
  token: string;
  repo: string;
}

function readEnv(): CliOpts {
  const url = process.env.SHARP_URL;
  const token = process.env.SHARP_TOKEN;
  const repo = process.env.SHARP_REPO;
  if (!url || !token) {
    process.stderr.write('sharp: SHARP_URL and SHARP_TOKEN must be set in the environment.\n');
    process.exit(2);
  }
  return { url, token, repo: repo ?? '' };
}

function parseFlag(args: string[], flag: string, defaultVal?: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0) return defaultVal;
  const v = args[i + 1];
  if (v === undefined) {
    process.stderr.write(`flag ${flag} requires a value\n`);
    process.exit(2);
  }
  args.splice(i, 2);
  return v;
}

function clientFor(args: string[]): SharpClient {
  const opts = readEnv();
  const repo = parseFlag(args, '--repo', opts.repo);
  if (!repo) {
    process.stderr.write('sharp: repo required (--repo or SHARP_REPO)\n');
    process.exit(2);
  }
  return new SharpClient({ url: opts.url, token: opts.token, repo });
}

async function adminCreateRepo(args: string[]): Promise<void> {
  const env = readEnv();
  const name = args[0];
  if (!name) {
    process.stderr.write('usage: sharp admin create-repo <name> [--default-branch <ref>]\n');
    process.exit(2);
  }
  const defaultBranch = parseFlag(args, '--default-branch', 'main');
  const client = new SharpClient({ url: env.url, token: env.token, repo: name });
  await client.ensureRepo({ defaultBranch });
  process.stdout.write(`created repo ${name}\n`);
}

async function adminIssueToken(args: string[]): Promise<void> {
  const env = readEnv();
  const principal = parseFlag(args, '--principal');
  const scope = parseFlag(args, '--scope');
  if (!principal || !scope) {
    process.stderr.write(
      'usage: sharp admin issue-token --principal <p> --scope <read|read_no_episodes|write|operator>\n',
    );
    process.exit(2);
  }
  const res = await fetch(`${env.url}/admin/tokens`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ principal, scope }),
  });
  if (!res.ok) {
    process.stderr.write(`token issue failed: ${res.status} ${await res.text()}\n`);
    process.exit(1);
  }
  const body = (await res.json()) as { token: string };
  process.stdout.write(`token: ${body.token}\n`);
  process.stdout.write(
    `(secret shown once; record it now and run sharp commands with SHARP_TOKEN set)\n`,
  );
}

async function repoList(): Promise<void> {
  const env = readEnv();
  const res = await fetch(`${env.url}/repos`, {
    headers: { authorization: `Bearer ${env.token}` },
  });
  if (!res.ok) {
    process.stderr.write(`list failed: ${res.status}\n`);
    process.exit(1);
  }
  const body = (await res.json()) as {
    repos: { name: string; default_branch: string; objectformat: string }[];
  };
  for (const r of body.repos) {
    process.stdout.write(`${r.name}\t${r.default_branch}\t${r.objectformat}\n`);
  }
}

async function refList(args: string[]): Promise<void> {
  const client = clientFor(args);
  const refs = await client.listRefs();
  for (const r of refs) {
    process.stdout.write(`${r.name}\t${r.target_kind}\t${r.target}\n`);
  }
}

// ---------------------------------------------------------------------------
// Project commands
// ---------------------------------------------------------------------------

function clientUrlToken(args: string[]): { url: string; token: string; repo: string } {
  const opts = readEnv();
  const repo = parseFlag(args, '--repo', opts.repo);
  if (!repo) {
    process.stderr.write('sharp: repo required (--repo or SHARP_REPO)\n');
    process.exit(2);
  }
  return { url: opts.url, token: opts.token, repo };
}

async function projectRegister(args: string[]): Promise<void> {
  const { url, token, repo } = clientUrlToken(args);
  const branchRef = parseFlag(args, '--branch');
  const targetRef = parseFlag(args, '--target');
  if (!branchRef || !targetRef) {
    process.stderr.write('usage: sharp project register --branch <ref> --target <ref>\n');
    process.exit(2);
  }
  const res = await fetch(`${url}/repos/${encodeURIComponent(repo)}/projections`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ branch_ref: branchRef, target_ref: targetRef }),
  });
  if (!res.ok) {
    process.stderr.write(`project register failed: ${res.status} ${await res.text()}\n`);
    process.exit(1);
  }
  const body = (await res.json()) as { branch_ref: string; target_ref: string; status: string };
  process.stdout.write(
    `registered projection ${body.branch_ref} -> ${body.target_ref} (status: ${body.status})\n`,
  );
}

async function projectList(args: string[]): Promise<void> {
  const { url, token, repo } = clientUrlToken(args);
  const status = parseFlag(args, '--status');
  const qs = status ? `?status=${encodeURIComponent(status)}` : '';
  const res = await fetch(`${url}/repos/${encodeURIComponent(repo)}/projections${qs}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    process.stderr.write(`project list failed: ${res.status} ${await res.text()}\n`);
    process.exit(1);
  }
  const body = (await res.json()) as {
    projections: {
      branch_ref: string;
      target_ref: string;
      status: string;
      projection_commit: string | null;
    }[];
  };
  for (const p of body.projections) {
    process.stdout.write(
      `${p.branch_ref}\t->\t${p.target_ref}\t${p.status}\t${p.projection_commit ?? '-'}\n`,
    );
  }
}

async function projectPreview(args: string[]): Promise<void> {
  const { url, token, repo } = clientUrlToken(args);
  const branchRef = parseFlag(args, '--branch');
  const targetRef = parseFlag(args, '--target');
  if (!branchRef || !targetRef) {
    process.stderr.write('usage: sharp project preview --branch <ref> --target <ref>\n');
    process.exit(2);
  }
  const encoded = encodeURIComponent(`${branchRef}__${targetRef}`);
  const res = await fetch(`${url}/repos/${encodeURIComponent(repo)}/projections/${encoded}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    process.stderr.write(`project preview failed: ${res.status} ${await res.text()}\n`);
    process.exit(1);
  }
  const body = (await res.json()) as {
    branch_ref: string;
    target_ref: string;
    status: string;
    projection_commit: string | null;
    dilemma: unknown;
    computed_at: string;
  };
  process.stdout.write(
    [
      `branch_ref:        ${body.branch_ref}`,
      `target_ref:        ${body.target_ref}`,
      `status:            ${body.status}`,
      `projection_commit: ${body.projection_commit ?? '(none)'}`,
      `computed_at:       ${body.computed_at}`,
      body.dilemma ? `dilemma:           ${JSON.stringify(body.dilemma, null, 2)}` : '',
    ]
      .filter(Boolean)
      .join('\n') + '\n',
  );
}

async function devServer(): Promise<void> {
  process.stdout.write('Starting postgres container...\n');
  const pg = await startPostgres();

  process.stdout.write('Starting Sharp server...\n');
  const server = await startServer({ dsn: pg.url, allowRawSha1: true });

  const { token } = await issueToken(server.sql, {
    principal: 'operator',
    scope: 'operator',
  });

  const url = `http://127.0.0.1:${server.port}`;
  process.stdout.write(
    [
      '',
      'Sharp dev server started',
      `URL:   ${url}`,
      `Token: ${token}`,
      '',
      'Set in your shell:',
      `  export SHARP_URL=${url}`,
      `  export SHARP_TOKEN=${token}`,
      '',
    ].join('\n'),
  );

  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      process.stdout.write('\nShutting down...\n');
      Promise.all([server.stop(), pg.stop()]).then(
        () => resolve(),
        () => resolve(),
      );
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}

function printUsage(): void {
  process.stdout.write(
    [
      'sharp — database-native VCS for agentic software development',
      '',
      'Usage:',
      '  sharp dev',
      '  sharp admin create-repo <name> [--default-branch <ref>]',
      '  sharp admin issue-token --principal <p> --scope <s>',
      '  sharp repo list',
      '  sharp ref list [--repo <name>]',
      '  sharp project register --branch <ref> --target <ref> [--repo <name>]',
      '  sharp project list [--status <clean|dilemma|stale|error>] [--repo <name>]',
      '  sharp project preview --branch <ref> --target <ref> [--repo <name>]',
      '',
      'Environment:',
      '  SHARP_URL    Sharp server base URL',
      '  SHARP_TOKEN  Bearer token (issue with `sharp admin issue-token`)',
      '  SHARP_REPO   Default repo name',
      '',
    ].join('\n'),
  );
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const cmd = args.shift();
  switch (cmd) {
    case 'dev':
      return wrap(devServer());
    case 'admin': {
      const sub = args.shift();
      if (sub === 'create-repo') return wrap(adminCreateRepo(args));
      if (sub === 'issue-token') return wrap(adminIssueToken(args));
      printUsage();
      return 2;
    }
    case 'repo': {
      const sub = args.shift();
      if (sub === 'list') return wrap(repoList());
      printUsage();
      return 2;
    }
    case 'ref': {
      const sub = args.shift();
      if (sub === 'list') return wrap(refList(args));
      printUsage();
      return 2;
    }
    case 'project': {
      const sub = args.shift();
      if (sub === 'register') return wrap(projectRegister(args));
      if (sub === 'list') return wrap(projectList(args));
      if (sub === 'preview') return wrap(projectPreview(args));
      printUsage();
      return 2;
    }
    case '-h':
    case '--help':
    case 'help':
      printUsage();
      return 0;
    default:
      printUsage();
      return cmd ? 2 : 0;
  }
}

async function wrap(p: Promise<void>): Promise<number> {
  try {
    await p;
    return 0;
  } catch (e) {
    process.stderr.write(`sharp: ${(e as Error).message}\n`);
    return 1;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`sharp crashed: ${(err as Error).stack ?? err}\n`);
    process.exit(2);
  },
);
