#!/bin/sh
# Starts Mission Control as the hub (Linux, no admin rights needed) with its bridge, and starts each again when it stops.
# Run it once by hand, or from cron:  @reboot <checkout>/server/run-hub.sh  and  */10 * * * * <checkout>/server/run-hub.sh
# A second copy exits at once (the lock below), so the cron line every 10 minutes only brings back a hub that is not running.
# Logs: .data/logs/hub-server.log and hub-bridge.log, each moved to .old once it passes 10 MB.
cd "$(dirname "$0")/.." || exit 1
mkdir -p .data/logs
chmod 700 .data
exec 9>.data/hub.lock
flock -n 9 || exit 0
export PATH="$HOME/.local/opt/node/bin:$HOME/.local/bin:$PATH"
# The Claude sign-in made on a PC with "claude setup-token" (see set-claude-token), when there is one.
[ -f "$HOME/.claude-token.sh" ] && . "$HOME/.claude-token.sh"
export MC_RUNNER_PORT=off # no runner on the hub: it runs chats only, and the server starts claude itself
export MC_SUPERVISED=1 # the loop below starts the server again whenever it exits, so a Restart from a PC's panel is safe

roll() { [ -f "$1" ] && [ "$(stat -c %s "$1")" -gt 10485760 ] && mv -f "$1" "$1.old"; }

(
  while true; do
    roll .data/logs/hub-server.log
    echo "--- $(date -u +%FT%TZ) server starting" >> .data/logs/hub-server.log
    node server/index.js >> .data/logs/hub-server.log 2>&1
    sleep 3
  done
) &
(
  while true; do
    roll .data/logs/hub-bridge.log
    if [ -x bridge/run/mc-bridge ]; then
      [ -f bridge/run/mc-bridge.new ] && mv -f bridge/run/mc-bridge.new bridge/run/mc-bridge
      bridge/run/mc-bridge --data-dir .data --server 127.0.0.1:1701 >> .data/logs/hub-bridge.log 2>&1
      [ $? -eq 73 ] && sleep 60 # another bridge holds the lock
    fi
    sleep 5
  done
) &
wait
