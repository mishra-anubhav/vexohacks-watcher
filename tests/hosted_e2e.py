"""R15: the 9-step script on the hosted board (Superserve), checked from outside like a judge.

    .venv/bin/python tests/hosted_e2e.py        about 3.5 minutes; needs BOARD_URL and BOARD_TOKEN in .env

Starts the scripted demo through the public URL with the operator key, waits for the script,
presses End incident, then checks the board state and report fetched through the public URL.
"""
import json
import re
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
env = dict(l.split("=", 1) for l in (ROOT / ".env").read_text().splitlines() if "=" in l and not l.startswith("#"))
URL, TOKEN = env["BOARD_URL"].rstrip("/"), env["BOARD_TOKEN"]


def call(path, method="GET", token=True, timeout=30):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["X-Board-Token"] = TOKEN
    req = urllib.request.Request(URL + path, data=b"{}" if method == "POST" else None, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


print("Hosted board:", URL + "/app")
t0 = call("/demo/start", "POST")["started"]
print("Scripted demo started. Waiting for the 3-minute script...")
seen = 0
while time.time() < t0 + 165:
    ev = call("/incident/log")["events"]
    for e in ev[seen:]:
        if e["type"] in ("transcript", "board_change", "coach", "alert"):
            txt = e.get("text") or (e.get("prompt") or {}).get("message") or (e.get("alert") or {}).get("text") or ""
            print("  %5.0fs %-12s %s" % (e["ts"] - t0, e["type"], txt[:90]))
    seen = len(ev)
    time.sleep(3)
call("/incident/end", "POST")
print("End incident pressed. Waiting for the report...")
for _ in range(60):
    log = call("/incident/log")["events"]
    if any(e["type"] == "report" for e in log):
        break
    time.sleep(2)

state = call("/agents/state")
log = call("/incident/log")["events"]
by = lambda t: [e for e in log if e["type"] == t]
P = state["patients"]
adult = next((p for p in P if p["age_group"] == "adult"), None)
child = next((p for p in P if p["age_group"] == "child"), None)
first = lambda p: p["triage_history"][0]["to"] if p and p["triage_history"] else None
alerts = state["alerts"]
report = next((e for e in log if e["type"] == "report"), None)
md = report["markdown"] if report else ""
open_res = [r for r in state["requests"] if r["category"] == "resource" and r["status"] == "open"]
checks = [
    ("1 smoke hazard on floor 3", any("smoke" in h["kind"] + h["description"].lower() and h["floor"] == 3 for h in state["hazards"])),
    ("2 two patients, red adult + yellow child, floor 3", len(P) == 2 and first(adult) == "red" and first(child) == "yellow"
     and adult["floor"] == 3 and child["floor"] == 3),
    ("3 red patient with MED-1, not duplicated", len(P) == 2 and adult and adult["assigned_to"] == "MED-1"),
    ("4 road blocked + reroute action", any(r["kind"] == "reroute" for r in state["requests"])),
    ("5 two open requests", len(open_res) == 2),
    ("6 mayday with last words, spoken", len(by("mayday")) == 1 and any(a["kind"] == "mayday" and a.get("audio") for a in alerts)),
    ("7 acknowledged, no second mayday", len(by("ack")) == 1),
    ("8 one hospital pre-alert, spoken", len([a for a in alerts if a["kind"] == "prealert" and a.get("audio")]) == 1),
    ("9 report with numbers and timeline", "## Timeline" in md and "red 1, yellow 1" in md and "Open resource requests: 2" in md),
    ("+ camera description on every patient", P and all(p["vision"] for p in P)),
    ("+ coach guidance given", len(state.get("coaching", [])) >= 3),
    ("+ audio served through the public URL", bool(alerts) and urllib.request.urlopen(URL + alerts[0]["audio"], timeout=20).status == 200),
]
health = call("/agents/health")
checks.append(("+ viewers see board updates (not just transcripts)", len(by("board_change")) >= 8 and len(by("incident_state")) >= 5 and len(by("alert")) >= 3))
checks.append(("+ no agent errors (incl. refused posts)", not health["errors"]))
if health["errors"]:
    print("agent errors:", health["errors"][:5])
viewer = json.load(urllib.request.urlopen(URL + "/status", timeout=20))
checks.append(("+ public viewers are view-only", viewer["can_write"] is False))
print()
for name, ok in checks:
    print("  %-50s %s" % (name, "PASS" if ok else "FAIL"))
n = sum(ok for _, ok in checks)
print("\n%d/%d checks passed on the hosted board." % (n, len(checks)))
sys.exit(0 if n == len(checks) else 1)
