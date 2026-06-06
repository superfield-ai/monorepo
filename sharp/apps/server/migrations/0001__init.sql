-- Initial Sharp schema: repos and the content-addressed object store.
--
-- Object IDs are Git's content-addressing hash. SHA-1 is the v1 default
-- (matches `git init`'s default in 2026); SHA-256 is supported per
-- repository via objectformat=sha256 (matches Git's own transition path).
-- The `algo` column lets a single server host repos using either hash,
-- and supports the SHA-1 → SHA-256 migration window when the ecosystem
-- flips. See whitepaper §4.0.

create table repos (
  id uuid primary key,
  name text not null unique,
  default_branch text not null default 'main',
  objectformat text not null default 'sha1' check (objectformat in ('sha1', 'sha256')),
  created_at timestamptz not null default now()
);

create table objects (
  repo_id uuid not null references repos(id) on delete cascade,
  id bytea not null,
  algo text not null check (algo in ('sha1', 'sha256')),
  -- Git's four object kinds, plus 'tag' which the schema in whitepaper §4
  -- did not list explicitly; Sharp v1 needs it for annotated tag round-trip.
  kind text not null check (kind in ('blob', 'tree', 'commit', 'tag')),
  size bigint not null,
  -- Inflated payload (the bytes we hashed). Deflated form is reconstructed
  -- on demand for Git export.
  data bytea not null,
  created_at timestamptz not null default now(),
  primary key (repo_id, algo, id)
);

-- Object lookup by hash within a repo. Composite so the SHA-1/SHA-256 split
-- still gets a clean plan when both formats coexist during migration.
create index objects_by_id on objects (repo_id, id);
