"""Live screen and event bus.

    python3 server/server.py --camera video:media/helmetcam.mp4   a video file played as a live camera (loops)
    python3 server/server.py --camera iphone                      iPhone camera (Continuity Camera, found by name)
    python3 server/server.py --camera 0                           a camera by number
    python3 server/server.py --camera gopro                       GoPro preview (laptop on the GoPro Wi-Fi)

Open http://localhost:8090. Event producers post here:
    python3 bridge/bridge.py --post http://127.0.0.1:8090/events
    python3 sim/responders.py

Endpoints
    GET  /                 landing page (landing.html)
    GET  /app              live board (live.html)
    GET  /static/<file>    shared styles (design tokens)
    GET  /media/<file>     the body-cam video file (with Range, so the page can play it with sound)
    GET  /video.mjpg       camera feed          GET /frame.jpg   current frame
    GET  /status           camera status        GET /stream      all events (SSE)
    GET  /incident/log     events of the current incident (JSON list)
    POST /events           one JSON event; broadcast, logged, forwarded to the agents service
    POST /incident/start   start a new incident (clears the log)
    POST /incident/stop    stop the incident: agents stop listening (report still possible)
    POST /incident/end     ask the agents for the post-incident report
    POST /demo/start       start a fresh incident and play the 3-minute script (pretend band + MED-1/PD-1)
    POST /demo/stop        stop the scripted demo

Every event that does not come from the agents themselves is forwarded to the agents
service (--agents, default http://127.0.0.1:4111/event). The agents post their results
(incident_state, alert, speech, report) back to /events with "source": "agents".
Only listens on 127.0.0.1.
"""
import argparse
import subprocess
import sys
import itertools
import json
import queue
import threading
import time
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import cv2

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
GOPRO = "http://10.5.5.9:8080"
GOPRO_UDP = "udp://@0.0.0.0:8554?overrun_nonfatal=1&fifo_size=5000000"

p = argparse.ArgumentParser()
p.add_argument("--camera", default="video:" + str(ROOT / "media" / "helmetcam.mp4"),
               help="video:PATH, iphone, gopro, or a camera number")
p.add_argument("--port", type=int, default=8090)
p.add_argument("--agents", default="http://127.0.0.1:4111/event", help="agents service ('' = off)")
p.add_argument("--logdir", default=str(ROOT / "incidents"))
args = p.parse_args()

# ---- camera ------------------------------------------------------------------------------

latest = {"jpg": None, "at": 0.0, "status": "starting", "frames": 0, "video_pos": None}
VIDEO_FILE = Path(args.camera[6:]) if args.camera.startswith("video:") else None
latest_lock = threading.Lock()


def set_status(text):
    with latest_lock:
        latest["status"] = text


def publish(frame, video_pos=None):
    h, w = frame.shape[:2]
    if w > 1280:
        frame = cv2.resize(frame, (1280, int(h * 1280 / w)))
    ok, jpg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 75])
    if ok:
        with latest_lock:
            latest["jpg"], latest["at"] = jpg.tobytes(), time.time()
            latest["frames"] += 1
            latest["video_pos"] = video_pos


def gopro_get(path):
    with urllib.request.urlopen(GOPRO + path, timeout=3) as r:
        return r.read().decode("utf-8", "replace")


def find_camera(name):
    """Camera number by its macOS name (the numbers shift when devices come and go)."""
    import re
    import subprocess
    try:
        out = subprocess.run(["ffmpeg", "-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""],
                             capture_output=True, text=True, timeout=10).stderr
    except (OSError, subprocess.TimeoutExpired):
        return None
    video = out.split("video devices:")[-1].split("audio devices:")[0]
    for number, device in re.findall(r"\[(\d+)\] (.+)", video):
        if device.strip() == name:
            return int(number)
    return None


def video_loop(path):
    """Play a file at its own frame rate, as if it were a live camera. Loops at the end."""
    while True:
        cam = cv2.VideoCapture(path)
        if not cam.isOpened():
            set_status("video %s could not be opened" % path)
            time.sleep(3)
            continue
        fps = cam.get(cv2.CAP_PROP_FPS) or 30.0
        set_status("Recorded clip · played as live")
        start, n = time.time(), 0
        while True:
            ok, frame = cam.read()
            if not ok:
                break
            n += 1
            due = start + n / fps
            delay = due - time.time()
            if delay > 0:
                time.sleep(delay)
            elif delay < -0.5:          # fell behind: skip frames to stay real-time
                continue
            publish(frame, round(n / fps, 2))
        cam.release()


def camera_loop():
    if args.camera.startswith("video:"):
        return video_loop(args.camera[6:])
    if args.camera == "gopro":
        def keep_alive():
            while True:
                try:
                    gopro_get("/gopro/camera/keep_alive")
                except Exception:
                    pass
                time.sleep(3)
        threading.Thread(target=keep_alive, daemon=True).start()
    while True:
        cam = None
        if args.camera == "gopro":
            try:
                gopro_get("/gopro/camera/stream/start")
                cam = cv2.VideoCapture(GOPRO_UDP, cv2.CAP_FFMPEG)
            except Exception as e:
                set_status("GoPro not reachable at 10.5.5.9: join its Wi-Fi (%s)" % type(e).__name__)
        elif args.camera == "iphone":
            index = find_camera("iPhone Camera")
            if index is None:
                set_status("iPhone camera not found: keep it locked and near the Mac (Continuity Camera)")
            else:
                cam = cv2.VideoCapture(index)
        else:
            cam = cv2.VideoCapture(int(args.camera))
        if cam is None or not cam.isOpened():
            time.sleep(3)
            continue
        set_status("live: %s" % {"gopro": "GoPro", "iphone": "iPhone camera"}.get(args.camera, "camera " + args.camera))
        fails = 0
        while fails < 50:
            ok, frame = cam.read()
            if not ok:
                fails += 1
                time.sleep(0.05)
                continue
            fails = 0
            publish(frame)
        cam.release()
        set_status("feed lost, reconnecting...")
        time.sleep(1)


threading.Thread(target=camera_loop, daemon=True).start()

# ---- events ------------------------------------------------------------------------------

clients = set()
clients_lock = threading.Lock()
incident = {"id": None, "started": None, "log": [], "file": None}
incident_lock = threading.Lock()
seq = itertools.count(1)
to_agents = queue.Queue(maxsize=2000)


def broadcast(event):
    """Number the event, keep it in the incident log, send it to every page."""
    event.setdefault("ts", round(time.time(), 3))
    event["seq"] = next(seq)
    if incident["id"]:
        event.setdefault("incident_id", incident["id"])
    line = json.dumps(event, ensure_ascii=False)
    if event.get("type") not in ("transcript_partial", "bridge_status"):     # live-only, not part of the record
        with incident_lock:
            incident["log"].append(event)
            if incident["file"]:
                incident["file"].write(line + "\n")
                incident["file"].flush()
    with clients_lock:
        for q in list(clients):
            try:
                q.put_nowait(line)
            except queue.Full:
                pass
    if args.agents and event.get("source") != "agents" and event.get("type") not in ("transcript_partial", "bridge_status"):
        try:
            to_agents.put_nowait(line)
        except queue.Full:
            pass
    return event


def agents_forwarder():
    """Sends events to the agents service in order. A down service never blocks the bus."""
    warned = 0.0
    while True:
        line = to_agents.get()
        try:
            req = urllib.request.Request(args.agents, data=line.encode("utf-8"), method="POST",
                                         headers={"Content-Type": "application/json"})
            urllib.request.urlopen(req, timeout=5).close()
        except Exception as e:
            if time.time() - warned > 10:
                warned = time.time()
                print("agents service not reachable (%s)" % type(e).__name__, flush=True)


if args.agents:
    threading.Thread(target=agents_forwarder, daemon=True).start()


demo_procs = []


def stop_demo():
    for proc in demo_procs:
        if proc.poll() is None:
            proc.terminate()
    demo_procs.clear()


def start_demo():
    """The same script as tests/e2e.py: a pretend band 60 speaks the captain's lines (through
    Deepgram), falls at 1:30 (mayday) and 2:00 (double-tap), MED-1/PD-1 lines at 0:40, 1:00, 2:20."""
    stop_demo()
    py = sys.executable
    base = "http://127.0.0.1:%d" % args.port
    logs = Path(args.logdir) / "demo-logs"
    logs.mkdir(parents=True, exist_ok=True)
    for name, cmd in (("bridge", [py, str(ROOT / "bridge" / "bridge.py"), "--sim", "--replay", str(ROOT / "sim" / "cpt1_e2e.ogg"),
                                  "--falls", "90,120", "--taps", "128", "--seconds", "175", "--post", base + "/events", "--log", ""]),
                      ("responders", [py, str(ROOT / "sim" / "responders.py"), "--server", base])):
        demo_procs.append(subprocess.Popen(cmd, cwd=str(ROOT), stdout=open(logs / (name + ".log"), "w"), stderr=subprocess.STDOUT))


def start_incident(fields):
    Path(args.logdir).mkdir(parents=True, exist_ok=True)
    with incident_lock:
        if incident["file"]:
            incident["file"].close()
        incident["id"] = time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:4]
        incident["started"] = time.time()
        incident["log"] = []
        incident["file"] = open(Path(args.logdir) / (incident["id"] + ".jsonl"), "a", encoding="utf-8")
    return broadcast(dict(fields, type="incident_started", source="console", started=incident["started"]))

# ---- http --------------------------------------------------------------------------------


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code, obj):
        self._send(code, json.dumps(obj).encode())

    def do_GET(self):
        path = self.path.split("?")[0]
        if path in ("/", "/index.html"):
            self._send(200, (HERE / "landing.html").read_bytes(), "text/html; charset=utf-8")
        elif path in ("/app", "/app/"):
            self._send(200, (HERE / "live.html").read_bytes(), "text/html; charset=utf-8")
        elif path.startswith("/static/"):
            f = (HERE / "static" / Path(path).name)
            types = {".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".js": "text/javascript"}
            if f.is_file() and f.suffix in types:
                self._send(200, f.read_bytes(), types[f.suffix])
            else:
                self._send(404, b"not found", "text/plain")
        elif path == "/status":
            with latest_lock:
                s = {"status": latest["status"], "frames": latest["frames"], "video_pos": latest["video_pos"],
                     "frame_age": round(time.time() - latest["at"], 2) if latest["at"] else None}
            s["incident_id"] = incident["id"]
            s["video_url"] = "/media/" + VIDEO_FILE.name if VIDEO_FILE else None
            self._json(200, s)
        elif path.startswith("/media/"):
            if not VIDEO_FILE or Path(path).name != VIDEO_FILE.name or not VIDEO_FILE.is_file():
                return self._send(404, b"not found", "text/plain")
            size = VIDEO_FILE.stat().st_size
            start, end = 0, size - 1
            rng = self.headers.get("Range", "")
            if rng.startswith("bytes="):
                a, _, b = rng[6:].split(",")[0].partition("-")
                start = int(a) if a else max(0, size - int(b))
                end = min(int(b), size - 1) if a and b else end
            length = end - start + 1
            self.send_response(206 if rng else 200)
            self.send_header("Content-Type", "video/mp4")
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(length))
            if rng:
                self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
            self.end_headers()
            try:
                with open(VIDEO_FILE, "rb") as f:
                    f.seek(start)
                    left = length
                    while left > 0:
                        chunk = f.read(min(65536, left))
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        left -= len(chunk)
            except (BrokenPipeError, ConnectionResetError):
                pass
        elif path == "/incident/log":
            with incident_lock:
                self._json(200, {"incident_id": incident["id"], "started": incident["started"], "events": incident["log"]})
        elif path == "/frame.jpg":
            with latest_lock:
                jpg = latest["jpg"]
            self._send(200, jpg, "image/jpeg") if jpg else self._send(503, b"no frame yet", "text/plain")
        elif path == "/video.mjpg":
            self.send_response(200)
            self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            last = 0.0
            try:
                while True:
                    with latest_lock:
                        jpg, at = latest["jpg"], latest["at"]
                    if jpg and at != last:
                        last = at
                        self.wfile.write(b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: %d\r\n\r\n" % len(jpg))
                        self.wfile.write(jpg + b"\r\n")
                    time.sleep(1 / 20)
            except (BrokenPipeError, ConnectionResetError):
                return
        elif path == "/stream":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            q = queue.Queue(maxsize=1000)
            with clients_lock:
                clients.add(q)
            try:
                with incident_lock:
                    backlog = [json.dumps(e, ensure_ascii=False) for e in incident["log"]]
                for line in backlog:
                    self.wfile.write(b"data: " + line.encode() + b"\n\n")
                self.wfile.write(b'data: {"type": "replay_done"}\n\n')   # what follows is live
                self.wfile.flush()
                while True:
                    try:
                        line = q.get(timeout=15)
                        self.wfile.write(b"data: " + line.encode() + b"\n\n")
                    except queue.Empty:
                        self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                with clients_lock:
                    clients.discard(q)
        else:
            self._send(404, b"not found", "text/plain")

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(min(n, 2_000_000)).decode("utf-8", "replace") if n else "{}"
        try:
            event = json.loads(body)
            if not isinstance(event, dict):
                raise ValueError
        except ValueError:
            return self._send(400, b"not a JSON object", "text/plain")
        path = self.path.split("?")[0]
        if path == "/events":
            if not isinstance(event.get("type"), str):
                return self._send(400, b"event needs a type", "text/plain")
            demo_running = any(p.poll() is None for p in demo_procs)
            if demo_running and event.get("source") == "band" and not event.get("sim") and event["type"] != "bridge_status":
                return self._json(200, {"ignored": "real band muted while the scripted demo runs"})
            if incident["id"] is None and event["type"] not in ("bridge_status", "transcript_partial"):
                start_incident({"reason": "first event"})
            return self._json(200, {"seq": broadcast(event)["seq"]})
        if path == "/demo/start":
            e = start_incident({"scenario": "412 Oak St apartment fire (scripted demo)", "demo": True})
            start_demo()
            return self._json(200, {"incident_id": incident["id"], "started": e["started"]})
        if path == "/demo/stop":
            stop_demo()
            return self._json(200, {"stopped": True})
        if path == "/incident/start":
            stop_demo()
            e = start_incident(event)
            return self._json(200, {"incident_id": incident["id"], "started": e["started"]})
        if path == "/incident/stop":
            stop_demo()
            if incident["id"] is None:
                return self._send(409, b"no incident running", "text/plain")
            broadcast({"type": "incident_stopped", "source": "console"})
            return self._json(200, {"incident_id": incident["id"]})
        if path == "/incident/end":
            if incident["id"] is None:
                return self._send(409, b"no incident running", "text/plain")
            broadcast({"type": "incident_end", "source": "console"})
            return self._json(200, {"incident_id": incident["id"]})
        self._send(404, b"not found", "text/plain")


ThreadingHTTPServer.daemon_threads = True
server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
print("Live screen: http://localhost:%d   camera: %s   agents: %s" % (args.port, args.camera, args.agents or "off"),
      flush=True)
try:
    server.serve_forever()
except KeyboardInterrupt:
    pass
