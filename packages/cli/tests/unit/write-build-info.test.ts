import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeBuildInfo } from '../../scripts/write-build-info.ts';

async function tempFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'superfield-build-info-'));
  return path.join(dir, 'build-info.ts');
}

describe('writeBuildInfo', () => {
  it('prefers env overrides', async () => {
    const outputPath = await tempFile();
    const execFileSync = vi.fn();

    await writeBuildInfo({
      env: {
        SUPERFIELD_BUILD_VERSION: '1.2.3',
        SUPERFIELD_BUILD_COMMIT: 'abc1234',
        SUPERFIELD_BUILD_DATE: '2026-04-07T16:00:00Z',
      },
      execFileSync: execFileSync as typeof import('node:child_process').execFileSync,
      writeFile: fs.writeFile,
      now: () => new Date('2026-04-07T16:00:00Z'),
      outputPath,
    });

    const content = await fs.readFile(outputPath, 'utf8');
    expect(content).toContain('BUILD_VERSION = "1.2.3"');
    expect(content).toContain('BUILD_COMMIT = "abc1234"');
    expect(content).toContain('BUILD_DATE = "2026-04-07T16:00:00Z"');
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('falls back to git metadata and current time', async () => {
    const outputPath = await tempFile();
    const execFileSync = vi
      .fn()
      .mockImplementationOnce(() => 'v9.9.9\n')
      .mockImplementationOnce(() => 'deadbee\n');

    await writeBuildInfo({
      env: {},
      execFileSync: execFileSync as typeof import('node:child_process').execFileSync,
      writeFile: fs.writeFile,
      now: () => new Date('2026-04-07T16:00:00Z'),
      outputPath,
    });

    const content = await fs.readFile(outputPath, 'utf8');
    expect(content).toContain('BUILD_VERSION = "v9.9.9"');
    expect(content).toContain('BUILD_COMMIT = "deadbee"');
    expect(content).toContain('BUILD_DATE = "2026-04-07T16:00:00.000Z"');
  });
});
