import * as fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface BuildInfoDeps {
  env: NodeJS.ProcessEnv;
  execFileSync: typeof execFileSync;
  writeFile: typeof fs.writeFile;
  now: () => Date;
  outputPath: string;
}

export async function writeBuildInfo(deps: BuildInfoDeps): Promise<void> {
  const version = deps.env.SUPERFIELD_BUILD_VERSION?.trim() || gitTag(deps.execFileSync) || 'dev';
  const commit = deps.env.SUPERFIELD_BUILD_COMMIT?.trim() || gitCommit(deps.execFileSync) || 'unknown';
  const date = deps.env.SUPERFIELD_BUILD_DATE?.trim() || deps.now().toISOString();

  const content = [
    `export const BUILD_VERSION = ${JSON.stringify(version)};`,
    `export const BUILD_COMMIT = ${JSON.stringify(commit)};`,
    `export const BUILD_DATE = ${JSON.stringify(date)};`,
    '',
  ].join('\n');

  await deps.writeFile(deps.outputPath, content, 'utf8');
}

function gitTag(run: typeof execFileSync): string | null {
  try {
    return (
      String(
        run('git', ['describe', '--tags', '--exact-match'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }),
      ).trim() || null
    );
  } catch {
    return null;
  }
}

function gitCommit(run: typeof execFileSync): string | null {
  try {
    return (
      String(
        run('git', ['rev-parse', '--short', 'HEAD'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }),
      ).trim() || null
    );
  } catch {
    return null;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const outputPath = path.resolve(import.meta.dirname, '../build-info.ts');
  await writeBuildInfo({
    env: process.env,
    execFileSync,
    writeFile: fs.writeFile,
    now: () => new Date(),
    outputPath,
  });
}
