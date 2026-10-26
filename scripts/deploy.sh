#!/usr/bin/env bash
# Sync the repo to home and rebuild the stack.
# deploy/.env and deploy/passwd (the Mosquitto password file) live only on the server and are not in git:
# they must never be synced or deleted. If passwd is missing, it is rebuilt from MQTT_USER/MQTT_PASS in .env.
set -euo pipefail
cd "$(dirname "$0")/.."
HOST="${1:-home}"
rsync -a --delete --exclude node_modules --exclude .next --exclude .git --exclude '.env*' --exclude dist \
  --exclude 'deploy/passwd' ./ "$HOST":dog-tracker/
ssh "$HOST" 'cd dog-tracker/deploy && set -a && . ./.env && set +a
  if [ ! -f passwd ]; then
    [ -d passwd ] && sudo rmdir passwd
    docker run --rm -v "$PWD":/w eclipse-mosquitto:2 sh -c "touch /w/passwd && mosquitto_passwd -b /w/passwd \"$MQTT_USER\" \"$MQTT_PASS\" && chmod 644 /w/passwd"
    echo "rebuilt deploy/passwd"
  fi
  docker compose up -d --build 2>&1 | tail -5'
