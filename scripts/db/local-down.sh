#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
RUN=(); [ "$(id -u)" = "0" ] && RUN=(runuser -u postgres --)
"${RUN[@]}" "$PGBIN/pg_ctl" -D "$ROOT/.local/pg" -m fast stop
