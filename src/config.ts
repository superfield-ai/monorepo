import { readFileSync } from 'node:fs'
try {
  for (const line of readFileSync('.env', 'utf-8').split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0 && !line.startsWith('#'))
      process.env[line.slice(0, eq).trim()] ??= line.slice(eq + 1).trim()
  }
} catch {}
export const config = {
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgresql://nexum:nexum@localhost:5432/nexum',
  // Apache AGE Postgres URL (issues #75, #99). After the phase-1 cutover
  // AGE is a hard requirement and runs on the same Postgres as the primary
  // `DATABASE_URL` (apache/age:PG16_latest). This knob exists only so an
  // operator can point AGE traffic at a separate instance if needed; when
  // unset the AGE pool falls back to `DATABASE_URL`.
  AGE_DATABASE_URL: process.env.AGE_DATABASE_URL ?? '',
  PORT: parseInt(process.env.PORT ?? '3000'),
  AUTH_OFF: process.env.NEXUM_AUTH === 'off',
}
