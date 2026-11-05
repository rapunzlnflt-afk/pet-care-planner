#!/usr/bin/env bash
# Local contract test for pawfolio-sitter-inbox. Never touches the live project.
# Runs the real index.ts under Deno with a fake supabase-js backed by PGlite
# (real Postgres in WASM, migration 0009 applied), then drives it with the
# shared intake-crypto.js under Node. Optionally runs the same test against
# mock_server.py (MOCK=/path/to/mock_server.py) so both stay in step.
#   INTAKE_CRYPTO=/path/to/intake-crypto.js [MOCK=/path/to/mock_server.py] ./run.sh
# Needs: deno, node 20+, npm (installs @electric-sql/pglite into this folder).
set -euo pipefail
cd "$(dirname "$0")"
: "${INTAKE_CRYPTO:?set INTAKE_CRYPTO to intake-crypto.js}"
export INTAKE_CRYPTO
[ -d node_modules/@electric-sql/pglite ] || npm i --no-save --silent @electric-sql/pglite
cat > deno.json <<'J'
{ "nodeModulesDir": "manual" }
J
PIDS=()
trap 'kill ${PIDS[@]} 2>/dev/null || true; rm -f deno.json' EXIT
SUPABASE_URL=http://local SUPABASE_SERVICE_ROLE_KEY=test \
  MIGRATION=../../migrations/0009_pawfolio_sitter_inbox.sql PORT=8788 \
  deno run -A --import-map=import_map.json serve.ts > fn.log 2>&1 & PIDS+=($!)
for _ in $(seq 60); do grep -q "fn up" fn.log 2>/dev/null && break; sleep 1; done
node e2e.mjs http://127.0.0.1:8788/functions/v1/pawfolio-sitter-inbox fn http://127.0.0.1:8788
if [ -n "${MOCK:-}" ]; then
  python3 "$MOCK" 8787 > mock.log 2>&1 & PIDS+=($!)
  sleep 1
  node e2e.mjs http://127.0.0.1:8787/functions/v1/pawfolio-sitter-inbox mock http://127.0.0.1:8787
fi
