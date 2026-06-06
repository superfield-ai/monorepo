-- Agent episodes — the core whitepaper §5 schema, plus the redaction
-- audit log and a small representations table used by the semantic
-- layer (Phase 18).

create table episodes (
  id uuid primary key,
  repo_id uuid not null references repos(id) on delete cascade,
  parent_commit bytea not null,
  promoted_commit bytea,
  agent_identity text not null,
  model_id text not null,
  harness_version text not null,
  tool_versions jsonb not null,
  decoding_params jsonb not null,
  status text not null check (status in ('started', 'completed', 'failed', 'abandoned')),
  started_at timestamptz not null,
  finished_at timestamptz
);

create index episodes_by_parent on episodes (repo_id, parent_commit);
create index episodes_by_model on episodes (repo_id, model_id, status);
create index episodes_by_promoted on episodes (repo_id, promoted_commit) where promoted_commit is not null;

create table episode_artifacts (
  episode_id uuid not null references episodes(id) on delete cascade,
  seq integer not null,
  kind text not null check (kind in (
    'prompt','context','tool_call','tool_result',
    'intermediate_patch','validation','judge'
  )),
  content_ref bytea,
  inline jsonb,
  created_at timestamptz not null,
  primary key (episode_id, seq),
  -- Exactly one of content_ref or inline is set per row.
  check ((content_ref is null) <> (inline is null)),
  -- Inline payload size cap so callers can't accidentally inline a
  -- megabyte. Above the cap → caller must store as a CAS object and
  -- pass content_ref.
  check (inline is null or octet_length(inline::text) < 65536)
);

create table episode_links (
  from_episode uuid not null references episodes(id) on delete cascade,
  to_episode uuid not null references episodes(id) on delete cascade,
  relation text not null check (relation in (
    'sibling','retry_of','replay_of','superseded_by'
  )),
  created_at timestamptz not null,
  primary key (from_episode, to_episode, relation)
);

-- Redaction audit log. The original payload is destroyed at redaction
-- time; this table records who scrubbed what, when, and under what
-- policy.
create table episode_redactions (
  episode_id uuid not null references episodes(id) on delete cascade,
  seq integer not null,
  policy text not null,
  actor text not null,
  redacted_at timestamptz not null default now(),
  primary key (episode_id, seq, redacted_at)
);

-- Semantic representations (Phase 18 will populate). Stored as queryable
-- JSONB keyed on the underlying object id and a layer + version tuple
-- so future grammar bumps can produce a new row alongside the old one.
create table representations (
  repo_id uuid not null references repos(id) on delete cascade,
  object_id bytea not null,
  layer text not null check (layer in ('ast', 'symbols', 'references')),
  version text not null,
  data jsonb not null,
  created_at timestamptz not null default now(),
  primary key (repo_id, object_id, layer, version)
);
