/**
 * CLI entry for the Sharp server. Reads configuration from env vars,
 * starts the server, blocks on signals.
 */
import { startServer } from './server';

const dsn = process.env.SHARP_DSN;
if (!dsn) {
  console.error('SHARP_DSN is required');
  process.exit(2);
}

const port = process.env.SHARP_PORT ? Number(process.env.SHARP_PORT) : 5174;
const migrate = process.env.SHARP_MIGRATE_ON_BOOT !== '0';
const authDisabled = process.env.SHARP_AUTH_DISABLED === '1';
const allowRawSha1 = process.env.SHARP_ALLOW_RAW_SHA1 === '1';

const handle = await startServer({ dsn, port, migrate, authDisabled, allowRawSha1 });

const stop = async (sig: string) => {
  console.log(`received ${sig}, stopping`);
  await handle.stop();
  process.exit(0);
};
process.on('SIGINT', () => void stop('SIGINT'));
process.on('SIGTERM', () => void stop('SIGTERM'));

console.log(`sharp server listening at ${handle.url}`);
