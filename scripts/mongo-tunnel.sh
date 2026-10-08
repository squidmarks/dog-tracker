#!/usr/bin/env bash
# Forward localhost:27018 to the Mongo container on `home` (dev + tests). Idempotent.
set -euo pipefail
if nc -z 127.0.0.1 27018 2>/dev/null; then echo "tunnel already up on :27018"; exit 0; fi
IP="$(ssh home "docker inspect mongo-mongo-1 --format '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}'" | awk '{print $1}')"
ssh -fN -o ExitOnForwardFailure=yes -L "27018:${IP}:27017" home
echo "tunnel up: localhost:27018 -> ${IP}:27017 (via home)"
