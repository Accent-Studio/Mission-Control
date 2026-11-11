#!/bin/zsh
# Starts Mission Control on macOS. Double-click it in Finder (a .command file opens in Terminal), or run it in Terminal.
# It starts the phone bridge and the runner once, then the server, and starts the server again when it asks to (exit code 75).
# It opens Mission Control in the browser once the server answers. If a server already answers, it only opens the browser.
# Logs: the server's output shows in this window and goes to .data/logs/server.log; the bridge writes .data/logs/bridge.log,
# the runner .data/runner/runner.log.

cd "${0:A:h}" || exit 1
export PATH="$HOME/.local/opt/node/bin:$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
export MC_SUPERVISED=1

# Mission Control 2 is the default; the old pages stay at http://127.0.0.1:1700/ as a backup.
URL=http://127.0.0.1:1700/v2/
HEALTH=http://127.0.0.1:1700/api/health
healthy() { curl -fs -m 1 -o /dev/null "$HEALTH"; }

if healthy; then
  open "$URL"
  exit 0
fi

if ! command -v node >/dev/null; then
  echo "Node.js is not found. Install Node.js 22 or newer from nodejs.org, then try again."
  read -k1 "?Press any key to close."
  exit 1
fi

mkdir -p .data/logs
chmod 700 .data

# Moves a log to .old once it passes 10 MB.
roll() { [ -f "$1" ] && [ "$(stat -f %z "$1")" -gt 10485760 ] && mv -f "$1" "$1.old"; }

# The phone bridge, started once. It runs on after this window closes (it ignores the hangup) and outlives server
# restarts, as on Windows. Like run-bridge.bat it starts again on exit code 75 (the Restart bridge button), and a second
# bridge finds the lock taken and exits with code 73. Nothing happens when it was never built.
if [ -x bridge/run/mc-bridge ] || [ -f bridge/run/mc-bridge.new ]; then
  (
    trap '' HUP
    fails=0
    while true; do
      [ -f bridge/run/mc-bridge.new ] && mv -f bridge/run/mc-bridge.new bridge/run/mc-bridge && chmod +x bridge/run/mc-bridge
      # The bridge writes its own bridge.log; its console output (a crash message, for one) goes to bridge-console.log.
      roll .data/logs/bridge-console.log
      echo "--- $(date -u +%FT%TZ) bridge starting" >> .data/logs/bridge-console.log
      bridge/run/mc-bridge --data-dir .data --server 127.0.0.1:1701 >> .data/logs/bridge-console.log 2>&1
      code=$?
      [ $code -eq 75 ] && { fails=0; continue; }
      [ $code -eq 0 -o $code -eq 73 ] && break
      fails=$((fails + 1))
      if [ $fails -ge 5 ]; then
        echo "mc-bridge failed $fails times in a row, giving up. Last exit code $code." >> .data/logs/bridge-console.log
        break
      fi
      sleep $((fails * 3))
    done
  ) </dev/null &!
fi

# The runner owns the Claude processes, so a restart of the server (the Restart button, an update) leaves the running
# conversations alone. Like the bridge it outlives this window and server restarts. It is started again before every server
# start, so one that stopped comes back; while one runs, a second finds its port taken and exits at once (exit code 73).
# A new version of the runner is used from the next time it starts (the server log says when the running one is older).
start_runner() {
  [ "$MC_RUNNER_PORT" = off ] && return
  roll .data/logs/runner-console.log
  ( trap '' HUP; exec node server/runner/index.js >> .data/logs/runner-console.log 2>&1 ) </dev/null &!
}

# Opens the browser once the server answers.
(
  for i in {1..30}; do
    if healthy; then open "$URL"; exit 0; fi
    sleep 1
  done
  echo "Mission Control did not answer in 30 seconds. Look above in this window to see why."
) &
opener=$!

while true; do
  start_runner
  sleep 0.3 # the runner listens before the server looks for it
  roll .data/logs/server.log
  echo "--- $(date -u +%FT%TZ) server starting" >> .data/logs/server.log
  node server/index.js 2>&1 | tee -a .data/logs/server.log
  code=${pipestatus[1]}
  [ $code -eq 75 ] || break
done

kill $opener 2>/dev/null
if [ $code -ne 0 ]; then
  echo "Mission Control stopped with exit code $code."
  read -k1 "?Press any key to close."
fi
exit $code
