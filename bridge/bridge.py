"""Band bridge: one process that owns the band (one Bluetooth link) and turns it into
JSON events for the rest of the system.

    band 60 --audio--> Deepgram --> {"type": "transcript", ...}
            --events-> fall state machine --> fall / still / countdown / mayday / ack / cancel

Every event is one JSON line on stdout and is appended to events.jsonl. With --post URL
each event is also POSTed to the server (in the background; a down server never blocks).

Run from the project folder (Hackhathon-14/), where .env is:
    python3 bridge/bridge.py                     real band (number BAND below), Bluetooth
    python3 bridge/bridge.py --usb               real band on the USB cable
    python3 bridge/bridge.py --sim               pretend band: plays a voice file and falls twice
    python3 bridge/bridge.py --sim --replay sim/cpt1.ogg
    python3 bridge/bridge.py --post http://127.0.0.1:8080/events

Note: the LED stays solid blue the whole time (microphone on), so the band cannot show the
alarm. The countdown is shown by the dashboard / spoken instead.
"""
import argparse
import os
import json
import queue
import sys
import threading
import time
import urllib.request
from collections import deque
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "vexo-open-kit" / "examples" / "python"))   # kit.py also adds the library
import kit  # noqa: E402,F401
import speech  # noqa: E402
from vexo_open import audio  # noqa: E402
from vexo_open.sync import Band, VexoError  # noqa: E402
from vexo_open.transports.sim import SimTransport  # noqa: E402

BAND = 60                       # the team's band number: the one place it is written
RESPONDER = "FIRE-CPT-1"        # who wears the band

CHECK_SECONDS = 5.0             # stillness after a fall before the countdown starts
COUNTDOWN_SECONDS = 10.0        # time to double-tap ("I'm OK") before the mayday goes out
LANDING_SECONDS = 1.0           # movement right after the fall is the landing, not getting up
TRANSCRIPT_WINDOW = 30.0        # seconds of speech attached to a mayday

p = argparse.ArgumentParser(description="Band -> JSON events (transcript, fall alarm).")
p.add_argument("--sim", action="store_true", help="pretend band (no hardware)")
p.add_argument("--usb", action="store_true", help="USB cable instead of Bluetooth")
p.add_argument("--seconds", type=float, default=None, help="stop after this many seconds")
p.add_argument("--check", type=float, default=CHECK_SECONDS, help="seconds still before countdown")
p.add_argument("--countdown", type=float, default=COUNTDOWN_SECONDS, help="seconds to cancel")
p.add_argument("--no-text", action="store_true", help="no Deepgram (motion/fall only)")
p.add_argument("--replay", default=None, help="with --sim: Ogg Opus file the pretend band speaks")
p.add_argument("--post", default=None, help="also POST every event as JSON to this URL")
p.add_argument("--falls", default=None, help="with --sim: fall times in seconds, e.g. 90,120")
p.add_argument("--test-drop-stt", type=float, default=None, help=argparse.SUPPRESS)   # tests: cut Deepgram after N s
p.add_argument("--taps", default=None, help="with --sim: double-tap times in seconds, e.g. 128")
p.add_argument("--log", default=str(ROOT / "events.jsonl"), help="append events here ('' = off)")
args = p.parse_args()
if not (0 < args.check <= 3600 and 1 <= args.countdown <= 3600):
    raise SystemExit("--check must be above 0 and --countdown 1 or more.")

# ---- output ------------------------------------------------------------------------------

_out_lock = threading.Lock()
_log = open(args.log, "a", encoding="utf-8") if args.log else None
_posts = queue.Queue(maxsize=1000)


def emit(kind, quiet=False, **fields):
    """quiet=True: only sent to the server (live partial text), not printed or logged."""
    event = {"type": kind, "ts": round(time.time(), 3), "responder": RESPONDER, "source": "band"}
    if args.sim:
        event["sim"] = True        # a pretend band: lets the server tell it from the real one
    event.update(fields)
    line = json.dumps(event, ensure_ascii=False)
    if not quiet:
        with _out_lock:
            print(line, flush=True)
            if _log:
                _log.write(line + "\n")
                _log.flush()
    if args.post:
        try:
            _posts.put_nowait(line)
        except queue.Full:
            pass
    return event


def _poster():
    while True:
        line = _posts.get()
        try:
            req = urllib.request.Request(args.post, data=line.encode("utf-8"), method="POST",
                                         headers={"Content-Type": "application/json", "X-Board-Token": BOARD_TOKEN})
            urllib.request.urlopen(req, timeout=3).close()
        except Exception as error:   # server down or slow: drop it, never block the band
            print("post failed: %s" % type(error).__name__, file=sys.stderr, flush=True)


def _board_token():
    """Operator key for a hosted board: env BOARD_TOKEN, or BOARD_TOKEN= in .env."""
    tok = os.environ.get("BOARD_TOKEN", "")
    try:
        for line in open(ROOT / ".env", encoding="utf-8"):
            if not tok and line.startswith("BOARD_TOKEN="):
                tok = line.split("=", 1)[1].strip()
    except OSError:
        pass
    return tok


BOARD_TOKEN = _board_token()
if args.post:
    threading.Thread(target=_poster, daemon=True).start()

# ---- transcript --------------------------------------------------------------------------

heard = deque(maxlen=200)          # (time, text) of final sentences
heard_lock = threading.Lock()


def on_text(text, final):
    if not final:
        if text and args.post:
            emit("transcript_partial", quiet=True, text=text, final=False)
        return
    if not text:
        return
    now = time.time()
    with heard_lock:
        heard.append((now, text))
    emit("transcript", text=text, final=True)


def last_words(seconds=TRANSCRIPT_WINDOW, before=None):
    end = before or time.time()
    with heard_lock:
        return " ".join(t for at, t in heard if end - seconds <= at <= end + 1)


ears = None
stt = {"state": "off" if args.no_text else "starting", "restarts": 0, "audio": 0}


def start_ears():
    """(Re)connect to Deepgram. Called at start and whenever the connection has dropped."""
    global ears
    try:
        ears = speech.create(keyterm="Oak Street").start(on_text)
        stt["state"] = "live"
        print("Speech: %s" % ears.label, file=sys.stderr, flush=True)
        return True
    except VexoError as problem:
        ears = None
        stt["state"] = "error"
        print("No transcript right now: %s" % problem, file=sys.stderr, flush=True)
        return False


def ears_dropped():
    return ears is None or getattr(ears, "_done", None) is not None and ears._done.is_set()


def status_loop():
    """Every 2 s: reconnect Deepgram if it dropped, and tell the board whether the mic is live."""
    last_audio, last_try = 0, 0.0
    while True:
        time.sleep(2)
        if not args.no_text and ears_dropped() and time.time() - last_try > 3:
            last_try = time.time()
            stt["state"] = "reconnecting"
            if start_ears():
                stt["restarts"] += 1
                emit("stt_reconnected", restarts=stt["restarts"])
        audio_rate = (stt["audio"] - last_audio) / 2.0          # packets a second (the band sends 50)
        last_audio = stt["audio"]
        emit("bridge_status", quiet=True, mic="on" if audio_rate > 10 else "no audio", audio_pps=round(audio_rate),
             stt=stt["state"], band=band.name if band else None)


if not args.no_text:
    start_ears()

# ---- band --------------------------------------------------------------------------------

sim = None
if args.sim:
    packets = audio.ogg_packets(args.replay or kit.SAMPLE_SPEECH)
    sim = SimTransport(BAND, auto_tap=False, audio_packets=packets)
    transport = sim
else:
    transport = "serial" if args.usb else "ble"

print("Connecting to band %d (%s). Double-tap it first if on Bluetooth." %
      (BAND, "pretend" if sim else transport), file=sys.stderr, flush=True)
band = None
band = Band.connect(BAND, transport, auto_reconnect=True)
emit("band_connected", band=band.name)
threading.Thread(target=status_loop, daemon=True).start()
if args.test_drop_stt and ears:
    threading.Timer(args.test_drop_stt, lambda: (print("  [test] cutting the Deepgram connection", file=sys.stderr), ears._ws.close())).start()

inbox = queue.Queue()
band.on("free-fall", lambda e: inbox.put(("fall", e.time)))
band.on("motion-start", lambda e: inbox.put(("moved", e.time)))
band.on("double-tap", lambda e: inbox.put(("double-tap", e.time)))
band.on("activity", lambda e: inbox.put(("moved", e.time)) if e.state != "still" else None)
band.on("reconnecting", lambda e: inbox.put(("link-lost", None)))
band.on("reconnected", lambda e: inbox.put(("link-back", None)))
band.on("disconnect", lambda e: inbox.put(("gone", getattr(e, "reason", "?"))))


def on_audio(a):
    stt["audio"] += 1
    if ears and not ears_dropped():
        try:
            ears.feed(a.opus, a.seq)
        except Exception:
            stt["state"] = "reconnecting"     # the status loop reconnects


band.on("audio", on_audio)
band.configure(events=True, activity=True, audio=True)
print("Listening. The band light is solid blue: the microphone is on and its sound goes to Deepgram.",
      file=sys.stderr, flush=True)

if sim:
    # Story for the pretend band, mirroring steps 6 and 7 of the test script.
    c, n = args.check, args.countdown
    if args.falls:                      # a scripted story: falls and double-taps at given times
        for at in [float(x) for x in args.falls.split(",")]:
            sim.after(at, lambda at=at: (print("  [sim] falls at %gs" % at, file=sys.stderr), sim.tap("free-fall"),
                                         sim.set_activity("still")))
        for at in [float(x) for x in (args.taps or "").split(",") if x]:
            sim.after(at, lambda at=at: (print("  [sim] double-tap at %gs" % at, file=sys.stderr), sim.tap("double-tap")))
    a = 3 if not args.falls else 10 ** 6   # default story only without --falls
    sim.after(a, lambda: (print("  [sim] falls, lies still", file=sys.stderr), sim.tap("free-fall"),
                          sim.set_activity("still")))
    b = a + LANDING_SECONDS + c + n + 3
    sim.after(b, lambda: (print("  [sim] falls again", file=sys.stderr), sim.tap("free-fall")))
    sim.after(b + LANDING_SECONDS + c + n / 2,
              lambda: (print("  [sim] double-tap during countdown", file=sys.stderr), sim.tap("double-tap")))
    if args.seconds is None:
        args.seconds = max(b + LANDING_SECONDS + c + n + 3, len(packets) / 50 + 3)

# ---- fall state machine: watching -> checking -> countdown -> mayday ---------------------

state, since, fell_at, shown = "watching", 0.0, 0.0, None
end = None if args.seconds is None else time.time() + args.seconds

try:
    while end is None or time.time() < end:
        try:
            what, when = inbox.get(timeout=0.05)
        except queue.Empty:
            what = None
        now = time.time()

        if what == "fall" and state in ("watching", "mayday"):
            state, since, fell_at = "checking", now, when or now
            emit("fall", at=fell_at)
        elif what == "moved" and state == "checking" and now - since > LANDING_SECONDS:
            state = "watching"
            emit("cancel", reason="moved")
        elif what == "double-tap" and state in ("checking", "countdown"):
            emit("ack", fell_at=fell_at, during=state)
            state = "watching"
        elif what == "double-tap" and state == "mayday":
            emit("ack", fell_at=fell_at, during="mayday")   # responder OK after the mayday went out
            state = "watching"
        elif what == "link-lost":
            emit("link", status="lost")
        elif what == "link-back":
            emit("link", status="back")
        elif what == "gone":
            emit("link", status="gone", reason=when)
            break

        if state == "checking" and now - since >= LANDING_SECONDS + args.check:
            state, since, shown = "countdown", now, None
            emit("still", seconds=args.check, fell_at=fell_at)
        if state == "countdown":
            left = args.countdown - (now - since)
            if left <= 0:
                state = "mayday"
                emit("mayday", fell_at=fell_at, last_words=last_words(before=now),
                     window_seconds=TRANSCRIPT_WINDOW)
            elif int(left + 0.999) != shown:
                shown = int(left + 0.999)
                emit("countdown", left=shown)
except KeyboardInterrupt:
    pass
finally:
    try:
        band.configure(audio=False)
    except VexoError:
        pass
    band.disconnect()
    if ears:
        try:
            ears.stop()
        except VexoError:
            pass
    emit("band_disconnected")
