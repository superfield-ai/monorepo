import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export function check(path: string): boolean {
  return existsSync(resolve(path));
}
