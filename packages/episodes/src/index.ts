/**
 * @sharp/episodes — agent harness library.
 *
 * Wraps the Sharp server's episode endpoints behind a small ergonomic
 * surface harnesses can drop into a fan-out/judge/select loop.
 *
 * Usage:
 *   const sharp = new EpisodeApi({ url, token, repo });
 *   const ep = await sharp.openEpisode({ ... });
 *   await ep.appendArtifact('prompt', { role: 'system', content: '...' });
 *   await ep.appendArtifact('intermediate_patch', somePatchBuffer);
 *   await ep.finish({ status: 'completed', promotedCommit: '<hex>' });
 */

export type ArtifactKind =
  | 'prompt'
  | 'context'
  | 'tool_call'
  | 'tool_result'
  | 'intermediate_patch'
  | 'validation'
  | 'judge';

export type EpisodeStatus = 'completed' | 'failed' | 'abandoned';

export type LinkRelation = 'sibling' | 'retry_of' | 'replay_of' | 'superseded_by';

export interface EpisodeApiOptions {
  url: string;
  token: string;
  repo: string;
}

export interface OpenEpisodeOptions {
  parentCommit: string; // hex
  agentIdentity: string;
  modelId: string;
  harnessVersion: string;
  toolVersions?: Record<string, unknown>;
  decodingParams?: Record<string, unknown>;
}

export interface FinishEpisodeOptions {
  status: EpisodeStatus;
  promotedCommit?: string; // hex
}

/** Inline-vs-CAS routing: anything larger than this goes to the CAS. */
const INLINE_LIMIT = 32 * 1024;

export class SharpEpisodeError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'SharpEpisodeError';
  }
}

async function checkResponse(res: Response): Promise<void> {
  if (res.ok) return;
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = res.statusText;
  }
  throw new SharpEpisodeError(res.status, JSON.stringify(body));
}

export class EpisodeApi {
  constructor(private readonly opts: EpisodeApiOptions) {}

  private headers(extra: Record<string, string> = {}): HeadersInit {
    return {
      authorization: `Bearer ${this.opts.token}`,
      ...extra,
    };
  }

  /**
   * Push a payload to the server's CAS (as a blob) and return the hex id.
   * Used by `appendArtifact` for the "too big to inline" path.
   */
  private async putBlob(payload: Uint8Array): Promise<string> {
    const { hashObject, idHex } = await import('@sharp/git-canonical');
    const id = idHex(hashObject('blob', payload, 'sha1'));
    const res = await fetch(
      `${this.opts.url}/repos/${encodeURIComponent(this.opts.repo)}/objects/${id}?kind=blob&algo=sha1`,
      {
        method: 'PUT',
        headers: this.headers({ 'content-type': 'application/octet-stream' }),
        body: payload as unknown as BodyInit,
      },
    );
    await checkResponse(res);
    return id;
  }

  async openEpisode(opts: OpenEpisodeOptions): Promise<EpisodeHandle> {
    const res = await fetch(
      `${this.opts.url}/repos/${encodeURIComponent(this.opts.repo)}/episodes`,
      {
        method: 'POST',
        headers: this.headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({
          parent_commit: opts.parentCommit,
          agent_identity: opts.agentIdentity,
          model_id: opts.modelId,
          harness_version: opts.harnessVersion,
          tool_versions: opts.toolVersions ?? {},
          decoding_params: opts.decodingParams ?? {},
        }),
      },
    );
    await checkResponse(res);
    const { id } = (await res.json()) as { id: string };
    return new EpisodeHandle(this, id);
  }

  async listEpisodes(
    query: {
      modelId?: string;
      status?: EpisodeStatus | 'started';
      parentCommit?: string;
      promotedCommit?: string;
      limit?: number;
    } = {},
  ): Promise<unknown[]> {
    const u = new URL(`${this.opts.url}/repos/${encodeURIComponent(this.opts.repo)}/episodes`);
    if (query.modelId) u.searchParams.set('model_id', query.modelId);
    if (query.status) u.searchParams.set('status', query.status);
    if (query.parentCommit) u.searchParams.set('parent_commit', query.parentCommit);
    if (query.promotedCommit) u.searchParams.set('promoted_commit', query.promotedCommit);
    if (query.limit) u.searchParams.set('limit', String(query.limit));
    const res = await fetch(u, { headers: this.headers() });
    await checkResponse(res);
    return ((await res.json()) as { episodes: unknown[] }).episodes;
  }

  // Used by EpisodeHandle.

  async _appendArtifact(
    episodeId: string,
    kind: ArtifactKind,
    payload: unknown | Uint8Array,
  ): Promise<{ seq: number }> {
    let body: { kind: ArtifactKind; content_ref?: string; inline?: unknown };
    if (payload instanceof Uint8Array) {
      const id = await this.putBlob(payload);
      body = { kind, content_ref: id };
    } else {
      const json = JSON.stringify(payload);
      if (json.length >= INLINE_LIMIT) {
        // Auto-route oversized inline payloads through the CAS to keep
        // episode_artifacts rows small.
        const id = await this.putBlob(new Uint8Array(Buffer.from(json, 'utf8')));
        body = { kind, content_ref: id };
      } else {
        body = { kind, inline: payload };
      }
    }
    const res = await fetch(
      `${this.opts.url}/repos/${encodeURIComponent(this.opts.repo)}/episodes/${episodeId}/artifacts`,
      {
        method: 'POST',
        headers: this.headers({ 'content-type': 'application/json' }),
        body: JSON.stringify(body),
      },
    );
    await checkResponse(res);
    return (await res.json()) as { seq: number };
  }

  async _finish(episodeId: string, opts: FinishEpisodeOptions): Promise<void> {
    const res = await fetch(
      `${this.opts.url}/repos/${encodeURIComponent(this.opts.repo)}/episodes/${episodeId}/finish`,
      {
        method: 'POST',
        headers: this.headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({
          status: opts.status,
          promoted_commit: opts.promotedCommit,
        }),
      },
    );
    await checkResponse(res);
  }

  async _link(from: string, to: string, relation: LinkRelation): Promise<void> {
    const res = await fetch(
      `${this.opts.url}/repos/${encodeURIComponent(this.opts.repo)}/episodes/${from}/links`,
      {
        method: 'POST',
        headers: this.headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({ to_episode: to, relation }),
      },
    );
    await checkResponse(res);
  }

  /** Append an artifact that is already stored in the CAS, by hex id. */
  async _appendArtifactRef(
    episodeId: string,
    kind: ArtifactKind,
    contentRef: string,
  ): Promise<{ seq: number }> {
    const res = await fetch(
      `${this.opts.url}/repos/${encodeURIComponent(this.opts.repo)}/episodes/${episodeId}/artifacts`,
      {
        method: 'POST',
        headers: this.headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({ kind, content_ref: contentRef }),
      },
    );
    await checkResponse(res);
    return (await res.json()) as { seq: number };
  }

  /** Fetch all artifacts for an episode in the order stored on the server. */
  async _fetchArtifacts(episodeId: string): Promise<ArtifactRecord[]> {
    const res = await fetch(
      `${this.opts.url}/repos/${encodeURIComponent(this.opts.repo)}/episodes/${episodeId}/artifacts`,
      { headers: this.headers() },
    );
    await checkResponse(res);
    return ((await res.json()) as { artifacts: ArtifactRecord[] }).artifacts;
  }

  /**
   * Fetch metadata for a single episode by id.
   * Uses the list endpoint (no dedicated single-episode GET exists yet).
   */
  async _fetchEpisodeMeta(episodeId: string): Promise<EpisodeMeta> {
    const res = await fetch(
      `${this.opts.url}/repos/${encodeURIComponent(this.opts.repo)}/episodes`,
      { headers: this.headers() },
    );
    await checkResponse(res);
    const { episodes } = (await res.json()) as { episodes: EpisodeMeta[] };
    const found = episodes.find((e) => e.id === episodeId);
    if (!found) {
      throw new SharpEpisodeError(404, `episode ${episodeId} not found`);
    }
    return found;
  }
}

/** Artifact as returned by GET /repos/:repo/episodes/:id/artifacts */
export interface ArtifactRecord {
  seq: number;
  kind: ArtifactKind;
  content_ref: string | null;
  inline: unknown;
  created_at: string;
}

/** Episode metadata as returned by GET /repos/:repo/episodes */
export interface EpisodeMeta {
  id: string;
  parent_commit: string;
  agent_identity: string;
  model_id: string;
  harness_version: string;
  tool_versions: Record<string, unknown>;
  decoding_params: Record<string, unknown>;
  status: string;
}

export class EpisodeHandle {
  constructor(
    private readonly api: EpisodeApi,
    public readonly id: string,
  ) {}

  appendArtifact(kind: ArtifactKind, payload: unknown | Uint8Array): Promise<{ seq: number }> {
    return this.api._appendArtifact(this.id, kind, payload);
  }

  finish(opts: FinishEpisodeOptions): Promise<void> {
    return this.api._finish(this.id, opts);
  }

  linkSibling(otherId: string): Promise<void> {
    return this.api._link(this.id, otherId, 'sibling');
  }

  markSuperseded(losers: string[]): Promise<void> {
    return Promise.all(losers.map((l) => this.api._link(l, this.id, 'superseded_by'))).then(
      () => undefined,
    );
  }

  linkReplayOf(originalId: string): Promise<void> {
    return this.api._link(this.id, originalId, 'replay_of');
  }

  /**
   * Replay this episode with overridden provenance fields.
   *
   * Steps:
   *   1. Fetch the original episode's metadata and artifacts.
   *   2. Open a new episode with the same parent_commit / agent_identity /
   *      tool_versions, but override model_id, harness_version, and/or
   *      decoding_params from `overrides`.
   *   3. Re-append all prompt and context artifacts in sequence order.
   *   4. Link the new episode to this one with relation='replay_of'.
   *   5. Return the new EpisodeHandle.
   */
  async replay(overrides: {
    modelId?: string;
    harnessVersion?: string;
    decodingParams?: Record<string, unknown>;
  }): Promise<EpisodeHandle> {
    // 1. Fetch original episode metadata and artifacts in parallel.
    const [meta, artifacts] = await Promise.all([
      this.api._fetchEpisodeMeta(this.id),
      this.api._fetchArtifacts(this.id),
    ]);

    // 2. Open a new episode with the same parentCommit, overriding provenance.
    const newHandle = await this.api.openEpisode({
      parentCommit: meta.parent_commit,
      agentIdentity: meta.agent_identity,
      modelId: overrides.modelId ?? meta.model_id,
      harnessVersion: overrides.harnessVersion ?? meta.harness_version,
      toolVersions: meta.tool_versions,
      decodingParams: overrides.decodingParams ?? meta.decoding_params,
    });

    // 3. Re-append prompt and context artifacts in seq order.
    const replayKinds = new Set<ArtifactKind>(['prompt', 'context']);
    const sorted = [...artifacts].sort((a, b) => a.seq - b.seq);
    for (const artifact of sorted) {
      if (!replayKinds.has(artifact.kind)) continue;
      if (artifact.content_ref !== null) {
        // Artifact stored in CAS — reference it directly by hex id.
        await this.api._appendArtifactRef(newHandle.id, artifact.kind, artifact.content_ref);
      } else {
        await newHandle.appendArtifact(artifact.kind, artifact.inline);
      }
    }

    // 4. Link new episode to original with 'replay_of'.
    await this.api._link(newHandle.id, this.id, 'replay_of');

    return newHandle;
  }
}
