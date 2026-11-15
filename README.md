# Watcher

**Responders talk. The board fills itself.**

A hackathon prototype (VexoHacks) for fire and EMS incidents. The incident captain wears a Vexo
band. Agents listen to the radio, build a live incident board (patients with triage colours,
hazards, requests), read the body cam, coach junior responders, raise a spoken mayday when a
responder falls and stops moving, and write the after-action report.

> Prototype. Not for operational use.

## What it does

| Step | The responder | The system |
|---|---|---|
| 1 | "Engine 2 on scene, 412 Oak Street, heavy smoke from the third floor." | Address and smoke hazard (floor 3) on the board; safety prompt to all crews |
| 2 | "Two victims on floor 3. One adult not breathing, one child conscious with a cough." | Two patient cards: RED adult, YELLOW child, each with a body-cam frame and description |
| 3 | MED-1: "Taking the red patient, burns to both arms, starting airway." | Same patient updated (never duplicated); the coach tells MED-1 what to do next |
| 4 | PD-1: "Oak and 3rd is blocked by debris, reroute units via Pine." | Road-blocked hazard and a reroute action item |
| 5 | "Requesting a second ambulance and a ladder truck." | Two open requests |
| 6 | The band falls and stays still | Countdown, then a spoken **mayday** with the last words heard |
| 7 | Falls again, double-taps the band | **Acknowledged**, no mayday |
| 8 | MED-1: "Red patient transporting to Valley Care ER, ETA 8 minutes." | Spoken hospital pre-alert |
| 9 | End incident | After-action report: timeline, triage counts, open requests, falls and their outcome, response times, coaching given |

Spoken questions ("Should I go in?") get a direct, safety-first answer from the coach. Side
conversations near the band are ignored. Everything the coach says is advisory: command decides.

## Sponsors

| Sponsor | How Watcher uses it | Status |
|---|---|---|
| **VEXO** | The captain's wristband: microphone for the radio voice, fall and stillness detection (countdown → mayday), double-tap "I'm OK" | In the app |
| **Google DeepMind** | Gemini 3.1 Flash-Lite runs the intake agent (speech → board) and the coach; Gemini 3.8 Flash runs the vision agent (body-cam frame → casualty description); Gemini TTS is the last-resort voice | In the app |
| **MiniMax** | MiniMax Speech 2.8 speaks the mayday, acknowledgements, pre-alerts and coaching (two voices); MiniMax-M3.1-Flash writes the hospital pre-alert; MiniMax-M3 writes the after-action review | In the app |
| **Mastra** | The agent framework: five agents with structured output, model fallback chains, and the post-incident workflow (exact metrics → analyst agent → report) | In the app |
| **OpenAI** | gpt-6-luna is the fallback model behind every agent, so the board keeps working if a primary model fails | In the app (fallback) |
| **ElevenLabs** | Wired in as the second voice in the speech chain (MiniMax → ElevenLabs → Gemini) | Standby: needs a key with Text to Speech access |
| **Superserve** | Hosts the live board and the Mastra agents in a sandbox (Firecracker microVM) with a public preview URL; the laptop keeps only the band's Bluetooth bridge | In the app |
| **Stripe** | Event sponsor. Thank you for supporting VexoHacks | Not used |
| **Brex** | Event sponsor. Thank you for supporting VexoHacks | Not used |

Speech-to-text by **Deepgram** (nova-3, streaming).

## How it works

```
 Vexo band ──BLE──► bridge/bridge.py ──► server/server.py :8090 ──► live board (browser)
   voice             Deepgram transcript      event bus (SSE)          video, transcript,
   falls             fall state machine       body-cam frames          incident board, report
   double-tap        mayday / ack              │
                                               ▼  every event
 sim/responders.py ─────────────────►  agents/ (Mastra, Node) :4111
   MED-1, PD-1 lines                     intake agent    speech → patients / hazards / requests
                                         vision agent    body-cam frame → description
                                         coach agent     next steps for junior responders, answers questions
                                         comms agent     hospital pre-alert
                                         post-incident workflow → analyst agent → report
                                         speech          MiniMax → ElevenLabs → Gemini TTS
```

- The agents propose changes; a deterministic reducer (`agents/src/state.ts`) applies them, so
  an agent can't invent a patient id, duplicate a patient or lose a correction.
- Counts and times in the report are computed in code (`agents/src/metrics.ts`); the analyst
  agent only writes prose around them.
- An echo guard removes from the band's transcript anything the laptop itself just said
  (alerts, coaching) or the body-cam video's own speech.
- Every model call has a fallback, and every voice has a fallback: the demo never goes silent.

## Hosted on Superserve

The board and the agents run in a [Superserve](https://superserve.ai) sandbox, so anyone can open
the live board from a phone while the captain speaks into the band. The laptop keeps only the
band bridge (Bluetooth has to be local), which posts events to the hosted board.

```
 Vexo band ──BLE──► laptop: bridge/run.sh ──HTTPS──► Superserve sandbox
                                                       server.py :8090  ── public preview URL
                                                       agents (Mastra) :4111 (behind the board, /agents/…)
```

- **Watching is public, controlling is not.** Without the operator key the board is view-only.
  The key (`BOARD_TOKEN`, generated on first deploy, kept in `.env`) is sent by the bridge, and an
  operator opens `<board>/app?key=<BOARD_TOKEN>` once to get the buttons.
- **Audio plays in the operator's browser** (the cloud has no speakers): click **Sound on**.
- Deploy, check, remove:

```bash
node deploy/superserve.ts            # create or update the sandbox, start everything, print the URL
node deploy/superserve.ts --status
node deploy/superserve.ts --kill
.venv/bin/python tests/hosted_e2e.py # the 9-step script against the hosted board
```

`deploy/superserve.ts` needs `SUPERSERVE_API_KEY` in `.env` and the model keys; the band bridge
then posts to `BOARD_URL` from `.env` automatically.

## Setup

Requirements: macOS, Python 3.9+, Node 22.18+ (runs TypeScript directly), ffmpeg, a Vexo band.

```bash
# 1. the Vexo Open kit from the organisers, unchanged, inside this folder
git clone <vexo-open-kit repo> vexo-open-kit

# 2. Python side
python3 -m venv .venv
.venv/bin/python -m pip install bleak pyserial opencv-python

# 3. agents
cd agents && npm install && cd ..

# 4. keys: create .env in this folder (never commit it)
#    DEEPGRAM_API_KEY=...   OPENAI_API_KEY=...   GEMINI_API_KEY=...
#    MINIMAX_API_KEY=...    ELEVENLABS_API_KEY=... (optional)

# 5. the body-cam test video (not in this repo; for local testing only)
yt-dlp -f "bv*[height<=720][ext=mp4]+ba[ext=m4a]" --merge-output-format mp4 \
  -o media/helmetcam.av1.mp4 "https://www.youtube.com/watch?v=BflKuEpn7QY"
# H.264, so it plays in every browser and decodes in the cloud sandbox
ffmpeg -i media/helmetcam.av1.mp4 -c:v libx264 -crf 23 -pix_fmt yuv420p -c:a aac \
  -movflags +faststart media/helmetcam.mp4
```

The band number is set once, as `BAND` in `bridge/bridge.py`.

## Run

```bash
.venv/bin/python server/server.py                 # board at http://localhost:8090 (landing) and /app
(cd agents && npm start)                          # agents at http://127.0.0.1:4111
bridge/run.sh                                     # double-tap the band; reconnects by itself
```

On the board:

- **Run demo ▾** runs the 3-minute script in one of two modes:
  - **Scripted voice**: a pretend band speaks the captain's lines, falls and double-taps. No hardware.
  - **Live Vexo band**: you are the captain on the real band; MED-1 and PD-1 play automatically.
  A cue card above the transcript shows what to say or do next, with a countdown.
- **Start incident** (two clicks) starts a clean incident for a free-form live run.
- **Stop** stops the agents listening (two clicks); **End incident** writes the report (two clicks).
- **Sound on** plays the body-cam video's audio and the spoken alerts.
- **Video clip / Phone camera** picks the body cam. For the phone, the board shows a QR code: scan
  it, tap **Start camera**, and the phone streams its rear camera (5 frames a second) to the board.
  The QR carries a camera-only key: it can send frames, nothing else. The Vexo band stays the microphone.

Use `--camera iphone` on the server for a live iPhone body cam (Continuity Camera).

## Tests

```bash
.venv/bin/python -m unittest discover -s tests -v     # server, video, event bus, responders, page
cd agents && npm test                                 # board rules, metrics, coach triggers, echo guard
cd agents && npm run test:live                        # the agents on the real models (uses API credits)
.venv/bin/python tests/e2e.py                         # the full 9-step script, end to end (~3.5 min)
```

Requirements and test cases: [REQUIREMENTS.md](REQUIREMENTS.md). Design system: [DESIGN.md](DESIGN.md).

## Project layout

| Path | What |
|---|---|
| `bridge/` | Band → events: transcript, fall state machine, auto-reconnect (`run.sh`) |
| `server/` | Event bus, video, landing page and live board (`landing.html`, `live.html`, `static/tokens.css`) |
| `agents/` | Mastra agents, incident state, metrics, coach, echo guard, speech |
| `sim/` | Simulated responders (`script.json`) and the synthesized captain voice for the demo |
| `tests/` | Python tests and the end-to-end runner |

## Privacy and safety

- The band's microphone sends audio to Deepgram; tell people nearby. The light is solid blue
  while it listens.
- Keys live only in `.env`, which is git-ignored. Incident logs, recordings and frames are
  git-ignored too.
- Coaching is advisory and grounded in standard protocols (START triage, basic life support);
  it never gives medication or doses and always defers to the incident commander.
