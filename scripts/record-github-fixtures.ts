/**
 * Records real GitHub API responses as golden fixtures for MSW tests.
 *
 * Run in each installation state to build up the full fixture set:
 *
 *   GITHUB_TOKEN=ghu_... bun scripts/record-github-fixtures.ts
 *
 * The script detects the current state of your GitHub App installations and
 * writes the matching fixture file(s) to tests/fixtures/github/.
 *
 * States that map to fixture files:
 *   - No installations       → user-installations-empty.json
 *   - User + selected repos  → user-installations-personal-selected.json + installation-repos.json
 *   - Org  + selected repos  → user-installations-org-selected.json      + installation-repos.json
 *   - Any  + all repos       → user-installations-all-repos.json
 *
 * Token source (first wins):
 *   1. GITHUB_TOKEN env var
 *   2. ~/.superfield/config.yaml (first user entry)
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { pathToFileURL } from 'node:url';

const FIXTURES_DIR = path.resolve(import.meta.dirname, '../tests/fixtures/github');
const GITHUB_API = 'https://api.github.com';

async function readTokenFromConfig(): Promise<string | null> {
  try {
    const configPath = path.join(os.homedir(), '.superfield', 'config.yaml');
    const raw = await fs.readFile(configPath, 'utf8');
    const match = raw.match(/token:\s*(\S+)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

async function githubGet(path: string, token: string): Promise<unknown> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub API error ${res.status} for ${path}: ${await res.text()}`);
  }
  return res.json();
}

async function writeFixture(filename: string, data: unknown): Promise<void> {
  const outPath = path.join(FIXTURES_DIR, filename);
  await fs.writeFile(outPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  console.log(`  wrote ${filename}`);
}

async function main(): Promise<void> {
  const token =
    process.env.GITHUB_TOKEN?.trim() ||
    process.env.SUPERFIELD_TOKEN?.trim() ||
    (await readTokenFromConfig());

  if (!token) {
    console.error(
      'No token found. Set GITHUB_TOKEN or ensure ~/.superfield/config.yaml has a user entry.',
    );
    process.exit(1);
  }

  console.log('Fetching GET /user/installations...');
  const installationsResp = (await githubGet('/user/installations?per_page=100', token)) as {
    total_count: number;
    installations: Array<{
      id: number;
      app_id: number;
      app_slug: string;
      repository_selection: string;
      account: { login: string; type: string } | null;
      created_at: string;
      updated_at: string;
      [key: string]: unknown;
    }>;
  };

  const installations = installationsResp.installations;

  if (installations.length === 0) {
    await writeFixture('user-installations-empty.json', installationsResp);
    console.log('\nState: no installations. Recorded user-installations-empty.json.');
    return;
  }

  // Detect state from the first installation and write the matching fixture
  for (const inst of installations) {
    const accountType = inst.account?.type ?? 'User';
    const repoSelection = inst.repository_selection;

    // Build a trimmed fixture that only includes fields our client and tests care about
    const trimmedInst = {
      id: inst.id,
      app_id: inst.app_id,
      app_slug: inst.app_slug,
      repository_selection: inst.repository_selection,
      account: inst.account
        ? { login: inst.account.login, type: inst.account.type }
        : null,
      created_at: inst.created_at,
      updated_at: inst.updated_at,
    };

    const resp = { total_count: installationsResp.total_count, installations: [trimmedInst] };

    let fixtureFile: string;
    if (repoSelection === 'all') {
      fixtureFile = 'user-installations-all-repos.json';
    } else if (accountType === 'Organization') {
      fixtureFile = 'user-installations-org-selected.json';
    } else {
      fixtureFile = 'user-installations-personal-selected.json';
    }

    await writeFixture(fixtureFile, resp);
    console.log(
      `  (installation id=${inst.id}, account=${inst.account?.login}, type=${accountType}, selection=${repoSelection})`,
    );

    // Record repos for the first selected installation
    if (repoSelection === 'selected') {
      console.log(`\nFetching GET /user/installations/${inst.id}/repositories...`);
      const reposResp = (await githubGet(
        `/user/installations/${inst.id}/repositories?per_page=100`,
        token,
      )) as {
        total_count: number;
        repositories: Array<{
          id: number;
          full_name: string;
          private: boolean;
          [key: string]: unknown;
        }>;
      };

      const trimmedRepos = {
        total_count: reposResp.total_count,
        repositories: reposResp.repositories.map((r) => ({
          id: r.id,
          full_name: r.full_name,
          private: r.private,
        })),
      };

      await writeFixture('installation-repos.json', trimmedRepos);
    }
  }

  console.log('\nDone. Run in other installation states to complete the fixture set:');
  console.log('  - No app installed             → user-installations-empty.json');
  console.log('  - Personal account, selected   → user-installations-personal-selected.json');
  console.log('  - Org account, selected        → user-installations-org-selected.json');
  console.log('  - Any account, all repos       → user-installations-all-repos.json');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
