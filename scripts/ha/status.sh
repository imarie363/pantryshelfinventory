#!/bin/bash
# Shows which machine serves Pantry Shelf and how fresh the standby's copy is.
. "$(dirname "$0")/common.sh"
echo "This machine:      $(role)$([ "$(role)" = active ] && echo ' (serving Pantry Shelf)')"
echo "Last copy:         $(last_sync_text)"
if on_primary true 2>/dev/null; then
  running="$(on_primary "cd '$PRIMARY_DIR' && docker compose ps -q --status running" 2>/dev/null | wc -l)"
  echo "main-vm:      reachable, $([ "$running" -gt 0 ] && echo serving || echo stopped)"
else
  echo "main-vm:      not reachable"
fi
[ -f "$STATE_DIR/last-error" ] && echo "Last copy error:   $(tail -1 "$STATE_DIR/last-error")"
exit 0
