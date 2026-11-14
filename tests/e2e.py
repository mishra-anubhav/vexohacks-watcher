"""R11 end-to-end: the 9-step apartment-fire script, start to report, then checks every "Pass if".

    .venv/bin/python tests/e2e.py              about 3.5 minutes; leaves the live screen running
    .venv/bin/python tests/e2e.py --stop       stop the server and agents afterwards
    .venv/bin/python tests/e2e.py --quiet      no spoken alerts on the laptop speakers

What runs:
  server/server.py         helmet-cam video as the body cam, event bus, live screen (localhost:8090)
  agents (Mastra)          intake, vision, comms, analyst agents + post-incident workflow (localhost:4111)
  bridge/bridge.py --sim   pretend band 60: speaks the captain's lines (sim/cpt1_e2e.ogg, through real
                           Deepgram), falls at 1:30 (no reaction -> mayday) and 2:00 (double-tap -> ack)
  sim/responders.py        MED-1 and PD-1 lines at 0:40, 1:00, 2:20
  at 2:40                  End incident -> report
"""
import argparse
import json
import os
import re
import signal
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PY = str(ROOT / ".venv" / "bin" / "python")
BUS, AGENTS = "http://127.0.0.1:8090", "http://127.0.0.1:4111"
END_AT = 160

ap = argparse.ArgumentParser()
ap.add_argument("--stop", action="store_true", help="stop server and agents at the end")
ap.add_argument("--quiet", action="store_true", help="no spoken alerts on the speakers")
args = ap.parse_args()

logdir = ROOT / "incidents" / "e2e-logs"
logdir.mkdir(parents=True, exist_ok=True)
procs = []


def get(url, timeout=10):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.load(r)


def post(url, obj=None):
    req = urllib.request.Request(url, data=json.dumps(obj or {}).encode(), method="POST",
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.load(r)


def start(name, cmd, cwd=ROOT, env=None):
    f = open(logdir / (name + ".log"), "w")
    p = subprocess.Popen(cmd, cwd=cwd, stdout=f, stderr=subprocess.STDOUT, env=env, start_new_session=True)
    procs.append((name, p))
    return p


def free(port):
    out = subprocess.run(["lsof", "-ti", ":%d" % port, "-sTCP:LISTEN"], capture_output=True, text=True).stdout.split()
    for pid in out:
        os.kill(int(pid), signal.SIGTERM)
    if out:
        time.sleep(1)


def wait_for(fn, timeout, what):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            if fn():
                return
        except Exception:
            pass
        time.sleep(0.5)
    sys.exit("Timed out waiting for " + what)


# ---- 1. start the services --------------------------------------------------------------
print("Starting server and agents...")
free(8090)
free(4111)
start("server", [PY, "server/server.py"])
env = dict(os.environ, SPEAK_LOCALLY="0" if args.quiet else "1")
start("agents", ["node", "src/service.ts"], cwd=ROOT / "agents", env=env)
wait_for(lambda: get(BUS + "/status")["frames"] > 0, 20, "the video feed")
wait_for(lambda: get(AGENTS + "/health")["ok"], 30, "the agents service")
print("Live board: http://localhost:8090/app  (landing page: http://localhost:8090)")
subprocess.run(["open", "http://localhost:8090/app"])
time.sleep(2)

# ---- 2. run the script ------------------------------------------------------------------
inc = post(BUS + "/incident/start", {"scenario": "412 Oak St apartment fire"})
t0 = inc["started"]
print("Incident %s started. Running the 9-step script (%d s)..." % (inc["incident_id"], END_AT))
start("bridge", [PY, "bridge/bridge.py", "--sim", "--replay", "sim/cpt1_e2e.ogg", "--falls", "90,120", "--taps", "128",
                 "--seconds", str(END_AT + 5), "--post", BUS + "/events", "--log", ""])
start("responders", [PY, "sim/responders.py"])

shown = set()
while time.time() < t0 + END_AT:
    for e in get(BUS + "/incident/log")["events"]:
        key = e["seq"]
        if key in shown:
            continue
        shown.add(key)
        rel = e["ts"] - t0
        if e["type"] == "transcript":
            print("  %5.1fs  %-10s %s" % (rel, e.get("responder"), e.get("text")))
        elif e["type"] == "board_change":
            print("  %5.1fs  %-10s -> %s" % (rel, "AI", e.get("text")))
        elif e["type"] in ("fall", "still", "mayday", "ack", "alert", "speech"):
            print("  %5.1fs  %-10s ** %s %s" % (rel, e.get("responder", ""), e["type"],
                                                 (e.get("alert") or {}).get("text", "") or e.get("provider", "")))
    time.sleep(1)

print("Waiting for the agents to finish...")
get(AGENTS + "/health?wait", timeout=120)
post(BUS + "/incident/end")
print("End incident pressed. Waiting for the report...")
wait_for(lambda: any(e["type"] in ("report", "report_status") and e.get("status") != "running"
                     for e in get(BUS + "/incident/log")["events"]), 180, "the report")

# ---- 3. check every "Pass if" -----------------------------------------------------------
log = get(BUS + "/incident/log")["events"]
state = get(AGENTS + "/state")
health = get(AGENTS + "/health")
timing = json.loads((ROOT / "sim" / "cpt1_e2e.json").read_text())
band0 = next((e["ts"] for e in log if e["type"] == "band_connected"), t0)
by = lambda t: [e for e in log if e["type"] == t]
tr = by("transcript")
patients = state["patients"]
adult = next((p for p in patients if p["age_group"] == "adult"), None)
child = next((p for p in patients if p["age_group"] == "child"), None)
first = lambda p: (p["triage_history"][0]["to"] if p and p["triage_history"] else None)
txt = lambda p: " ".join(p["conditions"] + p["notes"]).lower() if p else ""
alerts = state["alerts"]
report = next((e for e in log if e["type"] == "report"), None)
md = report["markdown"] if report else ""
falls, stills, maydays, acks = by("fall"), by("still"), by("mayday"), by("ack")
results = []


def check(step, name, ok, detail=""):
    results.append((step, name, bool(ok), detail))


oak = next((e for e in tr if re.search(r"412 oak", e["text"], re.I)), None)
lat = (oak["ts"] - (band0 + timing["l1"]["end"])) if oak else None
check(1, "transcript within ~2 s", oak and lat <= 3.0, "latency %.1fs after speech ended" % lat if oak else "no transcript")
smoke = next((h for h in state["hazards"] if "smoke" in (h["kind"] + h["description"]).lower()), None)
check(1, "hazard smoke, floor 3", smoke and smoke["floor"] == 3, smoke and smoke["description"])
check(2, "2 patients: red (adult) + yellow (child), floor 3",
      len(patients) == 2 and first(adult) == "red" and first(child) == "yellow" and adult["floor"] == 3 and child["floor"] == 3,
      ", ".join("%s %s %s fl%s" % (p["id"], p["age_group"], first(p), p["floor"]) for p in patients))
check(3, "red patient updated, not duplicated (MED-1, burns, airway)",
      len(patients) == 2 and adult and adult["assigned_to"] == "MED-1" and "burn" in txt(adult) and "airway" in txt(adult),
      adult and "%s with %s: %s" % (adult["id"], adult["assigned_to"], txt(adult)))
road = next((h for h in state["hazards"] if "block" in (h["kind"] + h["description"]).lower() or "road" in h["kind"]), None)
reroute = next((r for r in state["requests"] if r["kind"] == "reroute"), None)
check(4, "road blocked hazard + reroute action item", road and reroute and reroute["category"] == "action",
      "%s | %s" % (road and road["description"], reroute and reroute["description"]))
open_res = [r for r in state["requests"] if r["category"] == "resource" and r["status"] == "open"]
check(5, "2 open requests (ambulance, ladder)", len(open_res) == 2 and any("ambulance" in r["kind"] + r["description"] for r in open_res)
      and any("ladder" in r["kind"] + r["description"] for r in open_res), ", ".join(r["description"] for r in open_res))
m = maydays[0] if maydays else None
still1 = next((s for s in stills if m and s.get("fell_at") == m.get("fell_at")), None)
check(6, "mayday 10 s after stillness, with last words",
      m and still1 and abs((m["ts"] - still1["ts"]) - 10) <= 1.5 and "ladder" in (m.get("last_words") or "").lower(),
      m and "%.1fs after still; last words: %s" % (m["ts"] - still1["ts"], m.get("last_words")) if m and still1 else "no mayday")
check(6, "mayday alert spoken", any(a["kind"] == "mayday" and a.get("audio") for a in alerts))
second = falls[1] if len(falls) > 1 else None
check(7, "second fall -> acknowledged, no mayday",
      second and len(acks) == 1 and acks[0].get("fell_at") == second.get("at") and len(maydays) == 1
      and any(a["kind"] == "ack" for a in alerts), "acks %d, maydays %d" % (len(acks), len(maydays)))
pre = [a for a in alerts if a["kind"] == "prealert"]
check(8, "patient transporting -> one hospital pre-alert",
      adult and adult["status"] == "transporting" and "valley care" in (adult["destination"] or "").lower() and adult["eta_min"] == 8
      and len(pre) == 1 and pre[0].get("audio"), pre and pre[0]["text"])
check(9, "report: timeline, 1 red + 1 yellow, 2 open requests, 1 mayday + 1 ack, response times",
      report and "## Timeline" in md and "red 1, yellow 1" in md and "Open resource requests: 2" in md
      and "1 mayday, 1 acknowledged" in md and "## Response times" in md, report and report.get("file"))
check("+", "every patient has a camera frame + vision description", patients and all(p["image"] and p["vision"] for p in patients),
      "; ".join("%s: %s" % (p["id"], p["vision"]) for p in patients))
coaching = state.get("coaching", [])
c_med = next((c for c in coaching if c["trigger"] == "assigned" and c["to"] == "MED-1"), None)
check("coach", "MED-1 assigned -> patient-care guidance (breathing first)",
      c_med and re.search(r"airway|breath|ventilat|cpr|oxygen", c_med["message"], re.I) and c_med.get("audio"), c_med and c_med["message"])
c_smoke = next((c for c in coaching if c["trigger"] == "hazard" and c["key"] == "hazard:" + (smoke or {}).get("id", "?")), None)
check("coach", "smoke hazard -> safety guidance to all crews",
      c_smoke and c_smoke["to"] == "ALL" and re.search(r"low|air|scba|exit|partner", c_smoke["message"] + " ".join(c_smoke["steps"]), re.I),
      c_smoke and c_smoke["message"])
c_road = next((c for c in coaching if c["trigger"] == "hazard" and road and c["key"] == "hazard:" + road["id"]), None)
check("coach", "blocked road -> route guidance", c_road and re.search(r"pine|avoid|route", c_road["message"], re.I), c_road and c_road["message"])
c_nudge = next((c for c in coaching if c["trigger"] == "nudge" and child and c["key"] == "nudge:" + child["id"]), None)
check("coach", "child left unassigned 60 s -> commander nudged",
      c_nudge and c_nudge["to"] == "FIRE-CPT-1" and 58 <= c_nudge["ts"] - child["first_ts"] <= 66,
      c_nudge and "%.0fs after report: %s" % (c_nudge["ts"] - child["first_ts"], c_nudge["message"]))
check("coach", "report lists the coaching given", "## Coaching given" in md)
check("+", "no agent errors", not health["errors"], "; ".join(health["errors"])[:200])

print("\n%-4s %-70s %s" % ("Step", "Pass if", "Result"))
for step, name, ok, detail in results:
    print("%-4s %-70s %s" % (step, name, "PASS" if ok else "FAIL"))
    if detail:
        print("     %s" % str(detail)[:160])
passed = sum(ok for *_, ok, _ in results)
print("\n%d/%d checks passed.  Intake latency: median %s ms.  Speech: %s.  Report: %s" % (
    passed, len(results), sorted(health["intake_ms"])[len(health["intake_ms"]) // 2] if health["intake_ms"] else "-",
    health["speech"]["elevenlabs"] if health["speech"]["elevenlabs"] == "on" else "Gemini TTS (ElevenLabs off)",
    report and report.get("file")))
(ROOT / "incidents" / (inc["incident_id"] + "-e2e.json")).write_text(json.dumps(
    [{"step": s, "check": n, "pass": ok, "detail": str(d)} for s, n, ok, d in results], indent=1))

for name, p in procs:
    if name in ("bridge", "responders"):
        p.terminate()
if args.stop:
    for name, p in procs:
        p.terminate()
else:
    print("The live screen keeps running at http://localhost:8090 (server and agents left running).")
sys.exit(0 if passed == len(results) else 1)
