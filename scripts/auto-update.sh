#!/bin/sh
# Rebuilds Pantry Shelf when GitHub has new commits on main.
# Run from cron, e.g. every 15 minutes. Prints a line only when it updates.
set -eu
cd "$(dirname "$0")/.."
git fetch --quiet origin main
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  git merge --ff-only --quiet origin/main
  # A standby machine (see docs/high-availability.md) only prepares the new version
  if [ "$(cat .role 2>/dev/null)" = standby ]; then docker compose build >/dev/null; else docker compose up -d --build; fi
  docker image prune -f >/dev/null
  echo "$(date '+%F %T') updated to $(git log -1 --format='%h %s')"
fi
