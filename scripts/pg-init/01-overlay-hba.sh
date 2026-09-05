#!/bin/bash
# scripts/pg-init/01-overlay-hba.sh
# Runs ONCE at first start of a fresh data directory, after initdb writes the
# default pg_hba.conf. We then overlay our dev-friendly version that allows
# trust over TCP from any host — safe because Postgres in dev only listens on
# the Docker host loopback.
set -euo pipefail
cp /docker-entrypoint-initdb.d/pg_hba.conf /var/lib/postgresql/data/pg_hba.conf
chown postgres:postgres /var/lib/postgresql/data/pg_hba.conf
chmod 600 /var/lib/postgresql/data/pg_hba.conf
