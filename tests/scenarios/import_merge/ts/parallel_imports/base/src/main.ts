import { existsSync } from 'node:fs';

export function check(path: string): boolean {
  return existsSync(path);
}
