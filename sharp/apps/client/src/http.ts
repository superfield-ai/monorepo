/**
 * Thin HTTP wrapper around the Sharp server. The Sharp client uses this
 * for every server interaction. Network negotiation in v1 is the simple
 * HEAD-walk model from engineering-plan §5.4.
 */
import type { ObjectKind, HashAlgo } from '@sharp/git-canonical';

export interface ClientOptions {
  url: string;
  token: string;
  repo: string;
}

export interface RefInfo {
  name: string;
  target_kind: 'hash' | 'symbolic';
  target: string;
  resolved?: string;
}

export class SharpHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(`${status} ${code}: ${message}`);
    this.name = 'SharpHttpError';
  }
}

async function checkResponse(res: Response): Promise<void> {
  if (res.ok) return;
  let body: { error?: { code?: string; message?: string } } | undefined;
  try {
    body = (await res.json()) as { error?: { code?: string; message?: string } };
  } catch {
    body = undefined;
  }
  throw new SharpHttpError(
    res.status,
    body?.error?.code ?? 'unknown',
    body?.error?.message ?? res.statusText,
  );
}

export class SharpClient {
  constructor(private readonly opts: ClientOptions) {}

  private headers(extra: Record<string, string> = {}): Headers {
    const h = new Headers(extra);
    h.set('authorization', `Bearer ${this.opts.token}`);
    return h;
  }

  private url(path: string): string {
    return `${this.opts.url}${path}`;
  }

  // --- Repo

  async ensureRepo(opts: { defaultBranch?: string } = {}): Promise<{ id: string }> {
    const res = await fetch(this.url('/repos'), {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ name: this.opts.repo, default_branch: opts.defaultBranch }),
    });
    if (res.status === 409) {
      // already exists
      const get = await fetch(this.url(`/repos/${encodeURIComponent(this.opts.repo)}`), {
        headers: this.headers(),
      });
      await checkResponse(get);
      return get.json() as Promise<{ id: string }>;
    }
    await checkResponse(res);
    return res.json() as Promise<{ id: string }>;
  }

  // --- Objects

  async putObject(kind: ObjectKind, payload: Uint8Array, algo: HashAlgo = 'sha1'): Promise<string> {
    // Sharp recomputes the hash on its side; we send the canonical bytes
    // and the URL contains the hex id. Use a dummy '0'*40 placeholder and
    // rely on the server's hash_mismatch error to bounce us if we're
    // wrong. To avoid that round-trip, we hash locally and pass the hex.
    const { hashObject, idHex } = await import('@sharp/git-canonical');
    const id = idHex(hashObject(kind, payload, algo));
    const res = await fetch(
      this.url(
        `/repos/${encodeURIComponent(this.opts.repo)}/objects/${id}?kind=${kind}&algo=${algo}`,
      ),
      {
        method: 'PUT',
        headers: this.headers({ 'content-type': 'application/octet-stream' }),
        body: payload as unknown as BodyInit,
      },
    );
    await checkResponse(res);
    return id;
  }

  async getObject(id: string): Promise<{ kind: ObjectKind; data: Uint8Array }> {
    const res = await fetch(
      this.url(`/repos/${encodeURIComponent(this.opts.repo)}/objects/${id}`),
      {
        headers: this.headers(),
      },
    );
    await checkResponse(res);
    const buf = new Uint8Array(await res.arrayBuffer());
    const kind = (res.headers.get('x-sharp-kind') as ObjectKind | null) ?? 'blob';
    return { kind, data: buf };
  }

  async objectExists(id: string): Promise<boolean> {
    const res = await fetch(
      this.url(`/repos/${encodeURIComponent(this.opts.repo)}/objects/${id}`),
      {
        method: 'HEAD',
        headers: this.headers(),
      },
    );
    return res.ok;
  }

  // --- Refs

  async listRefs(): Promise<RefInfo[]> {
    const res = await fetch(this.url(`/repos/${encodeURIComponent(this.opts.repo)}/refs`), {
      headers: this.headers(),
    });
    await checkResponse(res);
    const body = (await res.json()) as { refs: RefInfo[] };
    return body.refs;
  }

  async getRef(name: string): Promise<RefInfo | undefined> {
    const res = await fetch(this.url(`/repos/${encodeURIComponent(this.opts.repo)}/ref/${name}`), {
      headers: this.headers(),
    });
    if (res.status === 404) return undefined;
    await checkResponse(res);
    return (await res.json()) as RefInfo;
  }

  async createRef(name: string, targetHex: string): Promise<void> {
    const res = await fetch(this.url(`/repos/${encodeURIComponent(this.opts.repo)}/ref/${name}`), {
      method: 'PUT',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ target_kind: 'hash', target: targetHex }),
    });
    await checkResponse(res);
  }

  async updateRef(name: string, expectedOldHex: string, newTargetHex: string): Promise<void> {
    const res = await fetch(this.url(`/repos/${encodeURIComponent(this.opts.repo)}/ref/${name}`), {
      method: 'PUT',
      headers: this.headers({
        'content-type': 'application/json',
        'if-match': expectedOldHex,
      }),
      body: JSON.stringify({ target_kind: 'hash', target: newTargetHex }),
    });
    await checkResponse(res);
  }

  async setSymbolicRef(name: string, target: string): Promise<void> {
    const res = await fetch(this.url(`/repos/${encodeURIComponent(this.opts.repo)}/ref/${name}`), {
      method: 'PUT',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ target_kind: 'symbolic', target }),
    });
    await checkResponse(res);
  }

  // --- Commits

  async createCommit(input: {
    tree: string;
    parents: string[];
    author: { name_email: string; timestamp: number; timezone: string };
    committer: { name_email: string; timestamp: number; timezone: string };
    message: string;
    refUpdate?: { name: string; expectedOld?: string };
  }): Promise<string> {
    const res = await fetch(this.url(`/repos/${encodeURIComponent(this.opts.repo)}/commits`), {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        algo: 'sha1',
        tree: input.tree,
        parents: input.parents,
        author: input.author,
        committer: input.committer,
        message: input.message,
        ref_update: input.refUpdate
          ? { name: input.refUpdate.name, expected_old: input.refUpdate.expectedOld }
          : undefined,
      }),
    });
    await checkResponse(res);
    return ((await res.json()) as { id: string }).id;
  }

  async getCommit(id: string): Promise<{
    tree: string;
    parents: string[];
    author: { name_email: string; timestamp: number; timezone: string };
    message: string;
  }> {
    const res = await fetch(
      this.url(`/repos/${encodeURIComponent(this.opts.repo)}/commits/${id}`),
      { headers: this.headers() },
    );
    await checkResponse(res);
    return (await res.json()) as {
      tree: string;
      parents: string[];
      author: { name_email: string; timestamp: number; timezone: string };
      message: string;
    };
  }
}
