"""Simulated responders: posts the lines of sim/script.json as transcript events, each at
its offset ("at", seconds) from the start of the current incident.

    python3 sim/responders.py                    waits for an incident, then plays the script
    python3 sim/responders.py --speed 10         10x faster (for tests)

Each line becomes {"type": "transcript", "responder": "MED-1", "source": "sim", "text": ...}.
"""
import argparse
import json
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

p = argparse.ArgumentParser()
p.add_argument("--server", default="http://127.0.0.1:8090")
p.add_argument("--script", default=str(ROOT / "sim" / "script.json"))
p.add_argument("--speed", type=float, default=1.0, help="time scale: 2 = twice as fast")
p.add_argument("--wait", type=float, default=600, help="seconds to wait for an incident to start")
args = p.parse_args()


def get(path):
    with urllib.request.urlopen(args.server + path, timeout=5) as r:
        return json.load(r)


def post(event):
    req = urllib.request.Request(args.server + "/events", data=json.dumps(event).encode(), method="POST",
                                 headers={"Content-Type": "application/json"})
    urllib.request.urlopen(req, timeout=5).close()


lines = sorted(json.loads(Path(args.script).read_text()), key=lambda line: line["at"])
deadline = time.time() + args.wait
while True:
    try:
        log = get("/incident/log")
        if log.get("started"):
            break
    except OSError:
        pass
    if time.time() > deadline:
        sys.exit("No incident started within %g s." % args.wait)
    time.sleep(0.5)

started = log["started"]
print("Incident %s: playing %d lines" % (log["incident_id"], len(lines)), flush=True)
def still_running():
    try:
        now = get("/incident/log")
    except OSError:
        return True
    return now.get("incident_id") == log["incident_id"] and not any(e["type"] == "incident_stopped" for e in now["events"])


for line in lines:
    due = started + line["at"] / args.speed
    while time.time() < due:
        time.sleep(min(0.5, max(0.0, due - time.time())))
        if not still_running():
            sys.exit("Incident stopped or replaced: simulated responders stop.")
    if not still_running():
        sys.exit("Incident stopped or replaced: simulated responders stop.")
    post({"type": "transcript", "final": True, "source": "sim", "responder": line["responder"], "text": line["text"]})
    print("  %5.1fs %s: %s" % (time.time() - started, line["responder"], line["text"]), flush=True)
