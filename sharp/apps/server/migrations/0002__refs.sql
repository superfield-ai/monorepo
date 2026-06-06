-- Refs (branches, tags, HEAD).
--
-- target_kind = 'hash' for refs that point at a commit/tree/tag object.
-- target_kind = 'symbolic' for refs that point at another ref by name
-- (e.g. HEAD pointing at refs/heads/main). Symbolic refs are required
-- by Git interop because `git clone` reads HEAD's symbolic target to
-- pick the default branch.
create table refs (
  repo_id uuid not null references repos(id) on delete cascade,
  name text not null,
  target bytea,                                  -- non-null when target_kind='hash'
  symbolic_target text,                          -- non-null when target_kind='symbolic'
  target_kind text not null check (target_kind in ('hash', 'symbolic')),
  updated_at timestamptz not null default now(),
  primary key (repo_id, name),
  check (
    (target_kind = 'hash' and target is not null and symbolic_target is null) or
    (target_kind = 'symbolic' and symbolic_target is not null and target is null)
  )
);
