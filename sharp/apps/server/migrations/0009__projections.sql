create table projections (
  repo_id uuid not null references repos(id) on delete cascade,
  branch_ref text not null,
  target_ref text not null,
  branch_tip bytea,
  target_tip bytea,
  projection_commit bytea,
  status text not null check (status in ('clean','dilemma','stale','error')),
  dilemma jsonb,
  computed_at timestamptz not null default now(),
  primary key (repo_id, branch_ref, target_ref)
);

-- Trigger: when a ref updates, mark any matching projection as stale
create or replace function mark_projections_stale() returns trigger as $$
begin
  update projections
  set status = 'stale'
  where repo_id = NEW.repo_id
    and (branch_ref = NEW.name or target_ref = NEW.name)
    and status != 'stale';
  return NEW;
end;
$$ language plpgsql;

create trigger refs_stale_projections
after insert or update on refs
for each row execute function mark_projections_stale();
