-- Creates the least-privilege database role used by the MailHarbor portal.
--
--   * owns the `portal` schema (its own tables)
--   * may only SELECT listmonk's tables (all writes go through the listmonk API)
--
-- Run once as a superuser / the database owner, e.g.:
--   psql "$DATABASE_URL" -v pw='strong-password' -v owner=listmonk -f portal-role.sql
-- where `owner` is the role that owns listmonk's tables.

\set ON_ERROR_STOP on
SELECT format('CREATE ROLE mailharbor LOGIN PASSWORD %L', :'pw')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mailharbor') \gexec
SELECT format('ALTER ROLE mailharbor LOGIN PASSWORD %L', :'pw') \gexec

SELECT format('GRANT CONNECT ON DATABASE %I TO mailharbor', current_database()) \gexec
CREATE SCHEMA IF NOT EXISTS portal;
ALTER SCHEMA portal OWNER TO mailharbor;
GRANT USAGE ON SCHEMA public TO mailharbor;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO mailharbor;
-- Tables listmonk creates in future upgrades become readable automatically.
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT ON TABLES TO mailharbor', :'owner') \gexec
