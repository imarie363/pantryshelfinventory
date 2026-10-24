#!/bin/bash
# Runs every minute from cron on the standby VM.
# - While main-vm is serving: copies its data here every SYNC_EVERY seconds.
# - After a failover: if main-vm comes back on its own, stops its copy so only one serves.
. "$(dirname "$0")/common.sh"
exec 9>"$STATE_DIR/lock"
flock -n 9 || exit 0

if [ "$(role)" = active ]; then
  if on_primary "cd '$PRIMARY_DIR' && [ -n \"\$(docker compose ps -q --status running)\" ]" 2>/dev/null; then
    stop_primary >/dev/null 2>&1 && log "main-vm came back and was stopped, since this machine is serving now. Run failback.sh to move back."
  fi
  exit 0
fi

last="$(cat "$STATE_DIR/last-sync" 2>/dev/null || echo 0)"
[ $(( $(date +%s) - last )) -ge "$SYNC_EVERY" ] || exit 0
if pull_data 2>"$STATE_DIR/last-error"; then
  rm -f "$STATE_DIR/last-error"
else
  log "Couldn't copy from main-vm: $(tail -1 "$STATE_DIR/last-error"). Last good copy: $(last_sync_text)."
fi
