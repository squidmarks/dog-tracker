#!/usr/bin/env bash
# Write .env.local (gitignored) with Mongo credentials for dev/tests, fetched from home's deploy/.env.
set -euo pipefail
cd "$(dirname "$0")/.."
PW="$(ssh home "sed -n 's/^MONGO_PASSWORD=//p' ~/dog-tracker/deploy/.env")"
[ -n "$PW" ] || { echo "no MONGO_PASSWORD on home" >&2; exit 1; }
umask 077
cat > .env.local <<ENV
# Local dev + tests reach Mongo through scripts/mongo-tunnel.sh. Dev data lives in dogtracker_dev, tests in dogtracker_test.
MONGO_URL=mongodb://dogtracker:${PW}@127.0.0.1:27018/?authSource=admin&directConnection=true
MONGO_DB=dogtracker_dev
TEST_MONGO_DB=dogtracker_test
ENV
echo "wrote .env.local"
