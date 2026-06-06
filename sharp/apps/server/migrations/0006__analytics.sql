-- Read-only role for the SQL passthrough endpoint.
--
-- The `analytics_role` has SELECT only on tables exposed to operators
-- through `POST /repos/:repo/query`. Tables containing tokens, redaction
-- audit logs, and raw episode artifacts that haven't been redacted are
-- explicitly NOT granted — the SQL passthrough is for development /
-- training-data queries, not for security review of the audit trail
-- itself.

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'analytics_role') then
    create role analytics_role;
  end if;
end
$$;

grant select on
  repos,
  objects,
  refs,
  commit_paths,
  commit_metadata,
  episodes,
  episode_artifacts,
  episode_links,
  representations
to analytics_role;
