#!/usr/bin/env bash
# Starts a disposable local PostgreSQL 16 cluster for development and tests.
# This is NOT Supabase: it is plain Postgres plus supabase/local/auth-shim.sql,
# which recreates the small part of the Supabase platform our migrations rely on
# (auth schema, auth.uid(), anon/authenticated/service_role roles).
# Use the Supabase CLI (`supabase start`) when Docker is available.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
DATA="$ROOT/.local/pg"
PORT="${PGPORT:-54329}"
mkdir -p "$ROOT/.local"
# initdb refuses to run as root; containers often run as root, so delegate to
# the unprivileged postgres user when one exists.
RUN=()
if [ "$(id -u)" = "0" ]; then
  id postgres >/dev/null 2>&1 || { echo "Running as root and no postgres user exists" >&2; exit 1; }
  mkdir -p "$DATA"; chown postgres "$ROOT/.local" "$DATA"
  RUN=(runuser -u postgres --)
fi
if [ ! -f "$DATA/PG_VERSION" ]; then
  "${RUN[@]}" "$PGBIN/initdb" -D "$DATA" -U postgres --auth=trust -E UTF8 --locale=C.UTF-8 >/dev/null
  echo "listen_addresses='127.0.0.1'" >> "$DATA/postgresql.conf"
  echo "port=$PORT" >> "$DATA/postgresql.conf"
  echo "unix_socket_directories='$ROOT/.local'" >> "$DATA/postgresql.conf"
  echo "max_connections=200" >> "$DATA/postgresql.conf"
fi
if ! "${RUN[@]}" "$PGBIN/pg_ctl" -D "$DATA" status >/dev/null 2>&1; then
  "${RUN[@]}" "$PGBIN/pg_ctl" -D "$DATA" -l "$ROOT/.local/pg.log" -w start >/dev/null
fi
for db in resuto resuto_test; do
  psql -h 127.0.0.1 -p "$PORT" -U postgres -tAc "select 1 from pg_database where datname='$db'" | grep -q 1 \
    || psql -h 127.0.0.1 -p "$PORT" -U postgres -c "create database $db" >/dev/null
done
echo "Postgres ready on 127.0.0.1:$PORT (databases: resuto, resuto_test)"
