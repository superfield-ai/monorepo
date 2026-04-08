import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { parse, stringify } from 'yaml';

export type AgentRole = 'primary' | 'speculative';

export interface AgentSession {
  issueNumber: number;
  sessionId: string;
  role: AgentRole;
  startedAt: string;
}

// Keyed by issue number
export type SessionStore = Record<number, AgentSession>;

const SESSIONS_PATH = path.join(os.homedir(), '.superfield', 'sessions.yaml');

export async function loadSessions(filePath = SESSIONS_PATH): Promise<SessionStore> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return (parse(raw) as SessionStore) ?? {};
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

export async function saveSessions(
  store: SessionStore,
  filePath = SESSIONS_PATH,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, stringify(store), 'utf8');
}

export async function getSession(
  issueNumber: number,
  filePath = SESSIONS_PATH,
): Promise<AgentSession | null> {
  const store = await loadSessions(filePath);
  return store[issueNumber] ?? null;
}

export async function upsertSession(
  session: AgentSession,
  filePath = SESSIONS_PATH,
): Promise<void> {
  const store = await loadSessions(filePath);
  store[session.issueNumber] = session;
  await saveSessions(store, filePath);
}

export async function deleteSession(
  issueNumber: number,
  filePath = SESSIONS_PATH,
): Promise<void> {
  const store = await loadSessions(filePath);
  delete store[issueNumber];
  await saveSessions(store, filePath);
}
