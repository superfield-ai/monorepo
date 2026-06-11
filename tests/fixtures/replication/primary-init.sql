-- Primary initialisation for replication testing (issue #459).
--
-- Creates the replication user and grants it the REPLICATION privilege.
-- This SQL is executed by the postgres-primary container during first-time
-- initialisation (docker-entrypoint-initdb.d).
--
-- See docker-compose.replication.yml and docs/architecture.md §Substrate Reliability.

CREATE USER replicator WITH REPLICATION ENCRYPTED PASSWORD 'replicator_secret';

-- Allow the replication user to connect for physical replication via pg_hba.conf.
-- The Docker postgres image automatically adds "host replication replicator 0.0.0.0/0 md5"
-- when POSTGRES_REPLICATION_USER is set, but we also create the role explicitly here
-- so that manual setups without the env var also work.
SELECT pg_reload_conf();
