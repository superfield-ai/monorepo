-- Commit-side analytics primitives.
--
-- commit_paths records the file paths each commit touched (relative to
-- its parent(s)). Populated at commit-creation time. This is the index
-- behind the "all episodes that touched file X" query in v1-plan §6.
create table commit_paths (
  repo_id uuid not null references repos(id) on delete cascade,
  commit_id bytea not null,
  path text not null,
  primary key (repo_id, commit_id, path)
);

create index commit_paths_by_path on commit_paths (repo_id, path);

-- commit_metadata holds mutable annotations *about* a commit as an
-- artifact (review status, eval labels, deployment outcomes). Per
-- whitepaper §4.4 + §5.6 — provenance about *how* a commit was produced
-- lives on the episode, not here.
create table commit_metadata (
  repo_id uuid not null references repos(id) on delete cascade,
  commit_id bytea not null,
  namespace text not null,
  key text not null,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (repo_id, commit_id, namespace, key)
);
