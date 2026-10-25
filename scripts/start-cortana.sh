#!/usr/bin/env bash
# Start the standalone Cortana Web server (static SPA + /api/gateway BFF) in this container.
#
# Env it needs:
#   HERMES_DASHBOARD_USERNAME / HERMES_DASHBOARD_PASSWORD  dashboard admin creds (read from the
#                                                          s6 container env when not exported)
#   CORTANA_ACCESS_USERNAME / CORTANA_ACCESS_PASSWORD       Cortana's own Basic auth (from /opt/data/.env)
#   PORT / HOST                                            default 3000 / 0.0.0.0
set -euo pipefail

cd "$(dirname "$0")/.."

S6_ENV=/run/s6/container_environment
for key in HERMES_DASHBOARD_BASIC_AUTH_USERNAME HERMES_DASHBOARD_BASIC_AUTH_PASSWORD; do
  target="HERMES_DASHBOARD_${key#HERMES_DASHBOARD_BASIC_AUTH_}"
  if [ -z "${!target:-}" ] && [ -r "$S6_ENV/$key" ]; then
    export "$target=$(cat "$S6_ENV/$key")"
  fi
done

if [ -r /opt/data/.env ]; then
  set -a
  # shellcheck disable=SC1091
  . /opt/data/.env
  set +a
fi

: "${PORT:=3000}"
: "${HOST:=0.0.0.0}"
export PORT HOST

if [ ! -f dist/index.html ]; then
  echo "dist/ is missing - run 'npm run build' first" >&2
  exit 1
fi

exec node server.mjs
