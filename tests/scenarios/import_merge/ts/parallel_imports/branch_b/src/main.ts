import { existsSync } from 'node:fs';
import { statSync } from 'node:fs';

export function check(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}
