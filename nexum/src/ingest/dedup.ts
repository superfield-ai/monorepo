import { createHash } from 'node:crypto'
export const contentHash = (s: string) => createHash('sha256').update(s).digest('hex')
