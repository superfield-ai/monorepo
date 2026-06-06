/**
 * Episode storage.
 *
 * Wraps the `episodes`, `episode_artifacts`, `episode_links`, and
 * `episode_redactions` tables. The HTTP layer maps 1:1 onto these
 * functions; the @sharp/episodes library wraps the HTTP layer.
 */
import type postgres from 'postgres';

export type Sql = postgres.Sql | postgres.TransactionSql;

export type EpisodeStatus = 'started' | 'completed' | 'failed' | 'abandoned';

export type ArtifactKind =
  | 'prompt'
  | 'context'
  | 'tool_call'
  | 'tool_result'
  | 'intermediate_patch'
  | 'validation'
  | 'judge';

export type LinkRelation = 'sibling' | 'retry_of' | 'replay_of' | 'superseded_by';

export interface OpenEpisodeInput {
  repo: string;
  parent_commit: Uint8Array;
  agent_identity: string;
  model_id: string;
  harness_version: string;
  tool_versions: Record<string, unknown>;
  decoding_params: Record<string, unknown>;
}

export interface EpisodeRow {
  id: string;
  repo_id: string;
  parent_commit: Buffer;
  promoted_commit: Buffer | null;
  agent_identity: string;
  model_id: string;
  harness_version: string;
  tool_versions: unknown;
  decoding_params: unknown;
  status: EpisodeStatus;
  started_at: Date;
  finished_at: Date | null;
}

export async function openEpisode(sql: Sql, input: OpenEpisodeInput): Promise<{ id: string }> {
  const id = crypto.randomUUID();
  await sql`
    insert into episodes (
      id, repo_id, parent_commit, agent_identity, model_id,
      harness_version, tool_versions, decoding_params,
      status, started_at
    ) values (
      ${id}::uuid,
      ${input.repo}::uuid,
      ${Buffer.from(input.parent_commit)},
      ${input.agent_identity},
      ${input.model_id},
      ${input.harness_version},
      ${JSON.stringify(input.tool_versions)}::jsonb,
      ${JSON.stringify(input.decoding_params)}::jsonb,
      'started',
      now()
    )
  `;
  return { id };
}

export interface AppendArtifactInput {
  episodeId: string;
  kind: ArtifactKind;
  /** Provide one of content_ref (CAS pointer) or inline (small jsonb). */
  contentRef?: Uint8Array;
  inline?: unknown;
}

export async function appendArtifact(
  sql: Sql,
  input: AppendArtifactInput,
): Promise<{ seq: number }> {
  if ((input.contentRef === undefined) === (input.inline === undefined)) {
    throw new Error('exactly one of contentRef and inline must be set');
  }
  // Compute the next seq inside a transaction-safe scope: a row insert
  // with a coalesced max() works under serializable, but Postgres' default
  // is read-committed. Use a per-episode advisory lock for short bursts.
  const rows = await sql<{ next: number }[]>`
    select coalesce(max(seq), 0) + 1 as next
      from episode_artifacts where episode_id = ${input.episodeId}::uuid
  `;
  const seq = Number(rows[0]?.next ?? 1);
  if (input.contentRef !== undefined) {
    await sql`
      insert into episode_artifacts (episode_id, seq, kind, content_ref, created_at)
      values (${input.episodeId}::uuid, ${seq}, ${input.kind}, ${Buffer.from(input.contentRef)}, now())
    `;
  } else {
    await sql`
      insert into episode_artifacts (episode_id, seq, kind, inline, created_at)
      values (${input.episodeId}::uuid, ${seq}, ${input.kind}, ${JSON.stringify(input.inline)}::jsonb, now())
    `;
  }
  return { seq };
}

export interface FinishEpisodeInput {
  episodeId: string;
  status: Exclude<EpisodeStatus, 'started'>;
  promotedCommit?: Uint8Array;
}

export async function finishEpisode(sql: Sql, input: FinishEpisodeInput): Promise<void> {
  await sql`
    update episodes
       set status = ${input.status},
           finished_at = now(),
           promoted_commit = ${input.promotedCommit ? Buffer.from(input.promotedCommit) : null}
     where id = ${input.episodeId}::uuid
  `;
}

export async function linkEpisodes(
  sql: Sql,
  from: string,
  to: string,
  relation: LinkRelation,
): Promise<void> {
  await sql`
    insert into episode_links (from_episode, to_episode, relation, created_at)
    values (${from}::uuid, ${to}::uuid, ${relation}, now())
    on conflict do nothing
  `;
}

export interface ListEpisodesQuery {
  repo: string;
  modelId?: string;
  status?: EpisodeStatus;
  parentCommit?: Uint8Array;
  promotedCommit?: Uint8Array;
  limit?: number;
}

export async function listEpisodes(sql: Sql, q: ListEpisodesQuery): Promise<EpisodeRow[]> {
  const limit = Math.min(q.limit ?? 100, 1000);
  // Build the WHERE clause with the postgres template-literal helper so
  // parameters stay safely bound.
  const filters: postgres.PendingQuery<postgres.Row[]>[] = [sql`repo_id = ${q.repo}::uuid`];
  if (q.modelId) filters.push(sql`model_id = ${q.modelId}`);
  if (q.status) filters.push(sql`status = ${q.status}`);
  if (q.parentCommit) filters.push(sql`parent_commit = ${Buffer.from(q.parentCommit)}`);
  if (q.promotedCommit) filters.push(sql`promoted_commit = ${Buffer.from(q.promotedCommit)}`);

  const where = filters.reduce((acc, f, i) => (i === 0 ? f : sql`${acc} and ${f}`));
  const rows = await sql<EpisodeRow[]>`
    select id::text as id, repo_id::text as repo_id, parent_commit, promoted_commit,
           agent_identity, model_id, harness_version, tool_versions, decoding_params,
           status, started_at, finished_at
      from episodes
     where ${where}
     order by started_at desc
     limit ${limit}
  `;
  return rows;
}

export interface ArtifactRow {
  episode_id: string;
  seq: number;
  kind: ArtifactKind;
  content_ref: Buffer | null;
  inline: unknown;
  created_at: Date;
}

export async function listArtifacts(sql: Sql, episodeId: string): Promise<ArtifactRow[]> {
  return sql<ArtifactRow[]>`
    select episode_id::text as episode_id, seq, kind, content_ref, inline, created_at
      from episode_artifacts where episode_id = ${episodeId}::uuid order by seq
  `;
}

export interface RedactArtifactInput {
  episodeId: string;
  seq: number;
  policy: string;
  actor: string;
  /** Replacement payload — written to inline; original is destroyed. */
  redacted: unknown;
}

export async function redactArtifact(sql: postgres.Sql, input: RedactArtifactInput): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`
      update episode_artifacts
         set content_ref = null,
             inline = ${JSON.stringify(input.redacted)}::jsonb
       where episode_id = ${input.episodeId}::uuid and seq = ${input.seq}
    `;
    await tx`
      insert into episode_redactions (episode_id, seq, policy, actor)
      values (${input.episodeId}::uuid, ${input.seq}, ${input.policy}, ${input.actor})
    `;
  });
}
