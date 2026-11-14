#!/bin/zsh
# Keep the bridge connected to band 60: restart it whenever it gives up (out of range,
# band asleep, not double-tapped yet). Stops after 10 minutes without a connection, or Ctrl+C.
cd "$(dirname "$0")/.."
last_ok=$(date +%s)
while (( $(date +%s) - last_ok < 600 )); do
  echo "[run.sh] connecting to band 60 at $(date +%T) — double-tap the band if it is not found"
  start=$(date +%s)
  .venv/bin/python bridge/bridge.py --post http://127.0.0.1:8090/events "$@"
  (( $(date +%s) - start > 30 )) && last_ok=$(date +%s)   # it was connected for a while: reset the clock
  sleep 3
done
echo "[run.sh] no connection for 10 minutes: stopped"
