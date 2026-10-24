#!/bin/bash
# Run on the standby VM to hand Pantry Shelf back to main-vm after a failover.
# Copies everything that changed meanwhile back to main-vm first.
. "$(dirname "$0")/common.sh"
exec 9>"$STATE_DIR/lock"
flock 9

if [ "$(role)" = standby ]; then echo "main-vm is already the one serving."; exit 0; fi
if ! on_primary true 2>/dev/null; then echo "Can't reach main-vm ($PRIMARY) yet." >&2; exit 1; fi

on_primary "cd '$PRIMARY_DIR' && echo standby > .role && docker compose stop >/dev/null 2>&1; docker compose up --no-start >/dev/null 2>&1; true"
compose stop
# If anything below fails, keep serving from here
trap 'log "Moving back failed, so this machine keeps serving."; compose up -d' ERR

src="$(volume_path)"
tar -C "$src" -cz . | on_primary "set -e
  d=\$(docker volume inspect -f '{{.Mountpoint}}' '$VOLUME'); t=\$(mktemp -d)
  tar -xzf - -C \"\$t\"; [ -n \"\$(ls -A \"\$t\")\" ]
  find \"\$d\" -mindepth 1 -delete; cp -a \"\$t/.\" \"\$d/\"; rm -rf \"\$t\""
mkdir -p "$BACKUP_DIR"
tar -C "$BACKUP_DIR" -cz . | on_primary "mkdir -p '$PRIMARY_BACKUP_DIR' && tar -xzf - -C '$PRIMARY_BACKUP_DIR'"
on_primary "cd '$PRIMARY_DIR' && rm -f .role && docker compose up -d --build"
trap - ERR

set_role standby
date +%s > "$STATE_DIR/last-sync"
log "main-vm serves Pantry Shelf again. This machine is back on standby."
