#!/bin/bash
# Run on the standby VM to make it serve Pantry Shelf, e.g. when homelab-main is down
# or about to go into maintenance.
. "$(dirname "$0")/common.sh"
exec 9>"$STATE_DIR/lock"
flock 9

if [ "$(role)" = active ]; then echo "This machine is already serving Pantry Shelf."; exit 0; fi

if SSH_TIMEOUT=5 stop_primary >/dev/null 2>&1; then
  log "Stopped Pantry Shelf on homelab-main."
  if pull_data; then log "Copied the latest data from homelab-main."; else log "Couldn't copy the latest data; using the copy from $(last_sync_text)."; fi
else
  log "homelab-main didn't answer. Using the copy from $(last_sync_text)."
  log "If homelab-main comes back, it is stopped automatically within a minute."
fi

set_role active
compose up -d --build
log "This machine now serves Pantry Shelf. When homelab-main is fixed, run failback.sh here."
