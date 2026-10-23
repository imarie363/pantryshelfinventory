#!/bin/sh
# Rebuilds Pantry Shelf when GitHub has new commits on main.
# Run from cron, e.g. every 15 minutes. Prints a line only when it updates.
set -eu
cd "$(dirname "$0")/.."
git fetch --quiet origin main
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  git merge --ff-only --quiet origin/main
  docker compose up -d --build
  docker image prune -f >/dev/null
  echo "$(date '+%F %T') updated to $(git log -1 --format='%h %s')"
fi
