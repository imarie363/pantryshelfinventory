#!/bin/bash
# Shared settings and helpers for the standby scripts. Settings come from scripts/ha/ha.conf.
set -euo pipefail
HA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$HA_DIR/../.." && pwd)"
if [ ! -f "$HA_DIR/ha.conf" ]; then echo "Missing $HA_DIR/ha.conf: copy ha.conf.example and fill it in." >&2; exit 1; fi
. "$HA_DIR/ha.conf"
: "${PRIMARY:?Set PRIMARY in ha.conf}"
PRIMARY_DIR="${PRIMARY_DIR:-/pantry/pantry-shelf}"
BACKUP_DIR="${BACKUP_DIR:-/srv/pantry-backups}"
PRIMARY_BACKUP_DIR="${PRIMARY_BACKUP_DIR:-$BACKUP_DIR}"
SYNC_EVERY="${SYNC_EVERY:-300}"
KEEP_DAYS="${KEEP_DAYS:-90}"
SSH_TIMEOUT="${SSH_TIMEOUT:-8}"
# Docker names the data volume after the folder, so both machines use the folder name pantry-shelf
PROJECT="$(basename "$APP_DIR")"
VOLUME="${PROJECT}_pantry-data"
STATE_DIR="$APP_DIR/.ha"
mkdir -p "$STATE_DIR"

log() { echo "$(date '+%F %T') $*"; }
# "active" serves the app; "standby" keeps it stopped and only copies data. No file means active.
role() { cat "$APP_DIR/.role" 2>/dev/null || echo active; }
set_role() { echo "$1" > "$APP_DIR/.role"; }
on_primary() { ssh -o BatchMode=yes -o ConnectTimeout="$SSH_TIMEOUT" "$PRIMARY" "$@"; }
compose() { (cd "$APP_DIR" && docker compose "$@"); }

# The folder holding this machine's data volume, created (but not started) when missing
volume_path() {
  docker volume inspect -f '{{.Mountpoint}}' "$VOLUME" 2>/dev/null && return
  docker volume create --label com.docker.compose.project="$PROJECT" --label com.docker.compose.volume=pantry-data "$VOLUME" >/dev/null
  docker volume inspect -f '{{.Mountpoint}}' "$VOLUME"
}

last_sync_text() {
  local t; t="$(cat "$STATE_DIR/last-sync" 2>/dev/null || echo 0)"
  if [ "$t" = 0 ]; then echo "never"; else echo "$(( ($(date +%s) - t) / 60 )) min ago ($(date -d "@$t" '+%F %T'))"; fi
}

# Copy the data, settings and nightly backups from homelab-main. Only replaces the
# local copy once the whole download worked.
pull_data() {
  local dest tmp
  dest="$(volume_path)"; tmp="$STATE_DIR/incoming"
  rm -rf "$tmp"; mkdir -p "$tmp"
  on_primary "cd \"\$(docker volume inspect -f '{{.Mountpoint}}' '$VOLUME')\" && tar -cz ." | tar -xzf - -C "$tmp"
  if [ -z "$(ls -A "$tmp")" ]; then log "The copy from homelab-main was empty, so the old copy was kept."; return 1; fi
  on_primary "cat '$PRIMARY_DIR/.env'" > "$APP_DIR/.env.new"
  find "$dest" -mindepth 1 -delete
  cp -a "$tmp/." "$dest/"
  rm -rf "$tmp"
  mv "$APP_DIR/.env.new" "$APP_DIR/.env"; chmod 600 "$APP_DIR/.env"
  mkdir -p "$BACKUP_DIR"
  on_primary "tar -C '$PRIMARY_BACKUP_DIR' -cz ." | tar -xzf - -C "$BACKUP_DIR"
  find "$BACKUP_DIR" -name 'pantry-*.json' -mtime +"$KEEP_DAYS" -delete
  date +%s > "$STATE_DIR/last-sync"
}

# Stop the app and tunnel on homelab-main and mark it as standby, so its auto-update
# doesn't start them again and Cloudflare only sends visitors here.
stop_primary() {
  on_primary "cd '$PRIMARY_DIR' && echo standby > .role && docker compose stop"
}
