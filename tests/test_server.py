"""R1 (video source), R3 (event bus), R4 (simulated responders), R9.1 (page).

    .venv/bin/python -m unittest discover -s tests -v
"""
import json
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PY = sys.executable
VIDEO = ROOT / "media" / "helmetcam.mp4"


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class FakeAgents:
    """Stands in for the Mastra service: records what the bus forwards."""

    def __init__(self):
        self.received = []
        outer = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                body = self.rfile.read(int(self.headers["Content-Length"]))
                outer.received.append(json.loads(body))
                self.send_response(204)
                self.end_headers()

        self.port = free_port()
        self.httpd = HTTPServer(("127.0.0.1", self.port), H)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.agents = FakeAgents()
        cls.port = free_port()
        cls.base = "http://127.0.0.1:%d" % cls.port
        cls.logdir = tempfile.mkdtemp()
        cls.proc = subprocess.Popen([PY, str(ROOT / "server" / "server.py"), "--camera", "video:%s" % VIDEO,
                                     "--port", str(cls.port), "--agents", "http://127.0.0.1:%d/event" % cls.agents.port,
                                     "--logdir", cls.logdir], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(100):
            try:
                if cls.get("/status")["frames"] > 0:
                    break
            except OSError:
                pass
            time.sleep(0.1)

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        cls.proc.wait(5)
        cls.agents.httpd.shutdown()

    @classmethod
    def get(cls, path):
        with urllib.request.urlopen(cls.base + path, timeout=5) as r:
            return json.load(r)

    def post(self, path, obj=None, raw=None):
        data = raw if raw is not None else json.dumps(obj or {}).encode()
        req = urllib.request.Request(self.base + path, data=data, method="POST", headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=5) as r:
            return json.load(r)

    # ---- R1 video source
    def test_T1_1_frame_rate(self):
        a = self.get("/status")["frames"]
        time.sleep(2)
        b = self.get("/status")["frames"]
        self.assertGreaterEqual((b - a) / 2, 10, "fewer than 10 frames a second")

    def test_T1_2_current_frame(self):
        with urllib.request.urlopen(self.base + "/frame.jpg", timeout=5) as r:
            jpg = r.read()
        self.assertEqual(jpg[:2], b"\xff\xd8", "not a JPEG")
        self.assertGreater(self.get("/status")["video_pos"], 0.5, "still at the first frame")

    def test_T1_3_real_time_pace(self):
        a = self.get("/status")["video_pos"]
        time.sleep(3)
        b = self.get("/status")["video_pos"]
        if b < a:                    # looped meanwhile; skip rather than guess
            self.skipTest("video looped during the measurement")
        self.assertAlmostEqual(b - a, 3.0, delta=0.3)

    def test_T1_4_video_file_served_with_range(self):
        self.assertEqual(self.get("/status")["video_url"], "/media/helmetcam.mp4")
        req = urllib.request.Request(self.base + "/media/helmetcam.mp4", headers={"Range": "bytes=100-199"})
        with urllib.request.urlopen(req, timeout=5) as r:
            self.assertEqual(r.status, 206)
            self.assertEqual(len(r.read()), 100)
            self.assertTrue(r.headers["Content-Range"].startswith("bytes 100-199/"))
        with self.assertRaises(urllib.error.HTTPError):
            urllib.request.urlopen(self.base + "/media/other.mp4", timeout=5)

    # ---- R3 event bus
    def test_T3_1_post_reaches_sse_client(self):
        self.post("/incident/start")
        got = []

        def listen():
            with urllib.request.urlopen(self.base + "/stream", timeout=10) as r:
                for raw in r:
                    if raw.startswith(b"data: "):
                        e = json.loads(raw[6:])
                        got.append(e)
                        if e.get("text") == "bus test":
                            return

        t = threading.Thread(target=listen, daemon=True)
        t.start()
        time.sleep(0.5)
        self.post("/events", {"type": "transcript", "text": "bus test", "responder": "FIRE-CPT-1"})
        t.join(5)
        self.assertTrue(any(e.get("text") == "bus test" for e in got))

    def test_T3_6_stream_marks_end_of_replay(self):
        self.post("/incident/start")
        self.post("/events", {"type": "report", "markdown": "# r"})
        types = []
        with urllib.request.urlopen(self.base + "/stream", timeout=5) as r:
            for raw in r:
                if raw.startswith(b"data: "):
                    types.append(json.loads(raw[6:])["type"])
                    if types[-1] == "replay_done":
                        break
        self.assertEqual(types[-2:], ["report", "replay_done"])     # report is old news: replayed before the marker

    def test_T3_2_invalid_json_rejected(self):
        with self.assertRaises(urllib.error.HTTPError) as cm:
            self.post("/events", raw=b"not json")
        self.assertEqual(cm.exception.code, 400)
        with self.assertRaises(urllib.error.HTTPError) as cm:
            self.post("/events", {"no": "type"})
        self.assertEqual(cm.exception.code, 400)

    def test_T3_3_forwarded_to_agents_but_not_agent_output(self):
        self.post("/events", {"type": "transcript", "text": "forward me"})
        self.post("/events", {"type": "incident_state", "source": "agents"})
        self.post("/events", {"type": "transcript_partial", "text": "partial"})
        time.sleep(1)
        types = [(e["type"], e.get("text")) for e in self.agents.received]
        self.assertIn(("transcript", "forward me"), types)
        self.assertNotIn("incident_state", [t for t, _ in types])
        self.assertNotIn("transcript_partial", [t for t, _ in types])

    def test_T3_4_incident_start_resets_log(self):
        self.post("/events", {"type": "transcript", "text": "old"})
        started = self.post("/incident/start")
        log = self.get("/incident/log")
        self.assertEqual(log["incident_id"], started["incident_id"])
        self.assertEqual([e["type"] for e in log["events"]], ["incident_started"])
        self.assertTrue((Path(self.logdir) / (started["incident_id"] + ".jsonl")).exists())

    def test_T3_5_stop_incident(self):
        started = self.post("/incident/start")
        self.post("/incident/stop")
        log = self.get("/incident/log")
        self.assertEqual(log["incident_id"], started["incident_id"])
        self.assertEqual([e["type"] for e in log["events"]][-1], "incident_stopped")
        self.assertTrue(any(e["type"] == "incident_stopped" for e in self.agents.received))

    # ---- R4 simulated responders
    def test_T4_1_responders_play_on_time(self):
        script = Path(self.logdir) / "script.json"
        script.write_text(json.dumps([
            {"at": 10, "responder": "MED-1", "text": "line one"},
            {"at": 20, "responder": "PD-1", "text": "line two"},
            {"at": 30, "responder": "MED-1", "text": "line three"}]))
        self.post("/incident/start")
        t0 = time.time()
        subprocess.run([PY, str(ROOT / "sim" / "responders.py"), "--server", self.base, "--script", str(script),
                        "--speed", "10"], check=True, timeout=20, capture_output=True)
        log = self.get("/incident/log")
        lines = [e for e in log["events"] if e.get("source") == "sim"]
        self.assertEqual([e["text"] for e in lines], ["line one", "line two", "line three"])
        self.assertEqual([e["responder"] for e in lines], ["MED-1", "PD-1", "MED-1"])
        for e, want in zip(lines, (1.0, 2.0, 3.0)):
            self.assertAlmostEqual(e["ts"] - log["started"], want, delta=1.0)
        self.assertLess(time.time() - t0, 10)

    # ---- R9.1 page
    def test_T9_3_landing_links_to_app_and_styles_load(self):
        with urllib.request.urlopen(self.base + "/", timeout=5) as r:
            html = r.read().decode()
        self.assertIn('href="/app"', html)
        self.assertIn("/static/tokens.css", html)
        with urllib.request.urlopen(self.base + "/static/tokens.css", timeout=5) as r:
            self.assertIn("--cream: #fbfaf4", r.read().decode())
        with self.assertRaises(urllib.error.HTTPError):
            urllib.request.urlopen(self.base + "/static/../server.py", timeout=5)

    def test_T9_1_page_has_panels(self):
        with urllib.request.urlopen(self.base + "/app", timeout=5) as r:
            html = r.read().decode()
        for marker in ('id="video"', 'id="log"', 'id="patients"', 'id="hazards"', 'id="requests"', 'id="alerts"', 'id="coach"',
                       'id="end"'):
            self.assertIn(marker, html)


if __name__ == "__main__":
    unittest.main()
