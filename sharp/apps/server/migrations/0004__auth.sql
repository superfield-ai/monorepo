-- Bearer-token auth.
--
-- Tokens are hashed with sha256 before storage; the secret is shown to
-- the operator once at issue time and never persisted. Scopes:
--   read              objects/refs/repos/representations/episodes (everything)
--   read_no_episodes  objects/refs/repos/representations only
--   write             read + put objects, update refs, create commits, episodes
--   operator          write + create repos, issue tokens, run SQL passthrough
create table api_keys (
  token_hash bytea primary key,
  principal text not null,
  scope text not null check (scope in ('read', 'read_no_episodes', 'write', 'operator')),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index api_keys_by_principal on api_keys (principal);
