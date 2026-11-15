# Watcher — requirements and test cases

Scenario: apartment fire at 412 Oak St. FIRE-CPT-1 wears Vexo band 60 (voice, falls, double-tap).
MED-1 and PD-1 are simulated from `sim/script.json`. The body-cam feed is a real helmet-cam
video (`media/helmetcam.mp4`, MLive, "Helmet cam shows dramatic rescue from burning apartments
in Michigan", youtube.com/watch?v=BflKuEpn7QY) played as if it were live. Used locally for testing only.

## Architecture

```
 Vexo band 60 ──► bridge/bridge.py ──┐   (transcript, fall, still, countdown, mayday, ack)
 sim/responders.py ──────────────────┤   (MED-1 / PD-1 transcript lines on a timer)
                                     ▼
                         server/server.py  :8090   event bus + video + live screen
                         │  POST /events  ──► SSE /stream ──► browser (live.html)
                         │  GET /frame.jpg (current video frame)
                         ▼ forwards every event
                 agents/ (Mastra, Node)  :4111
                   intake agent      transcript → patient / hazard / request ops   (OpenAI)
                   vision agent      frame → short casualty description            (Gemini)
                   comms agent       transporting patient → hospital pre-alert     (OpenAI)
                   incident state    deterministic reducer (no duplicates, corrections)
                   speech            mayday / ack / pre-alert → audio (ElevenLabs, Gemini TTS fallback)
                   post-incident workflow (Mastra workflow): metrics → analysis agent → report
                 posts derived events back to the server: incident_state, alert, speech, report
```

## Requirements

| ID | Requirement | Acceptance (test cases) |
|---|---|---|
| R1 | Video source: the server plays an mp4 as a live camera (real-time pace, loops) and serves the current frame | T1.1 frames arrive at ≥10 fps · T1.2 `/frame.jpg` is the current frame, not frame 0 · T1.3 playback runs at real-time pace (±10 %) |
| R2 | Voice: band audio → Deepgram → `transcript` events (final + partial) | T2.1 sim band speaking script lines produces transcripts containing "412 Oak", "not breathing" |
| R3 | Event bus: server accepts events, broadcasts them over SSE, forwards them to the agents service, keeps the incident log | T3.1 POSTed event reaches an SSE client · T3.2 invalid JSON → 400 · T3.3 events are forwarded to agents · T3.4 incident start resets the log |
| R4 | Simulated responders: `sim/script.json` lines are posted as `transcript` events at their offsets from incident start | T4.1 3 lines posted, in order, at their offsets (±1 s), with responder MED-1/PD-1 |
| R5 | Intake agent + incident state: transcript → patients (triage colour, floor, notes), hazards, requests; updates instead of duplicates; corrections | T5.1 line 1 → hazard smoke, floor 3 · T5.2 line 2 → 2 patients, red + yellow, floor 3 · T5.3 MED-1 line → same red patient updated (notes burns/airway, assigned MED-1), still 2 patients · T5.4 PD-1 line → road-blocked hazard + reroute request · T5.5 line 5 → 2 open requests (ambulance, ladder) · T5.6 "Correction, the child is not breathing either" → yellow → red · T5.7 reducer unit tests (no LLM): create, update by id, no duplicate, correction, request close |
| R6 | Vision agent: on a new patient, grab the current video frame and attach a short description | T6.1 a frame from the helmet-cam video gets a non-empty description ≤ 20 words · T6.2 patient card carries `image` and `vision` after creation |
| R7 | Safety alerts: mayday and ack become alerts with spoken audio | T7.1 mayday → alert (severity critical) containing the last words · T7.2 ack → alert "acknowledged", no mayday · T7.3 audio file generated (ElevenLabs, or Gemini TTS fallback) |
| R8 | Hospital pre-alert: a patient set to "transporting" triggers one pre-alert (text + speech) | T8.1 MED-1 transport line → patient status transporting, destination Valley Care, ETA 8 · T8.2 exactly one pre-alert per patient |
| R9 | Live screen: video on top, transcript below, incident board (patients, hazards, requests, alerts), End incident button | T9.1 page serves and contains all panels · T9.2 board renders `incident_state` (manual check) |
| R10 | Post-incident workflow (Mastra): deterministic metrics + analysis agent → report | T10.1 counts 1 red, 1 yellow (before correction), 2 open requests, 1 mayday, 1 ack · T10.2 response times present (mayday → ack, request → now) · T10.3 report has timeline + narrative + recommendations |
| R12 | Responder coach ("SuperResponder", inspired by Marv Labs' SuperTechnician): advisory next-step guidance for junior responders, spoken and shown. Triggers: patient assigned to a unit → patient care; new hazard → safety/route to all crews; red/yellow patient unassigned 60 s → nudge the commander (deterministic text). Guardrails: ≤ 25 spoken words, 2–4 steps, no medication or doses, stays on the trigger, marked advisory, never delays a mayday (urgent audio jumps the queue) | T12.1–T12.4 trigger/nudge unit tests · T12.5 assigned red patient → breathing care first, no other patients · T12.6 smoke → safety only · T12.7 blocked road → route · e2e: MED-1 guidance, smoke + road guidance, nudge ~60 s after the child was reported, report lists coaching |
| R11 | End-to-end: the 9-step script runs from one command (sim band with spoken captain lines + falls, video, sim responders, End incident) | T11.1 every "Pass if" of the 9 steps in the test script holds |

## Running the tests

```
.venv/bin/python -m unittest discover -s tests -v          # Python side (R1–R4, R9)
cd agents && npm test                                     # reducer unit tests (R5.7, R10 metrics)
cd agents && npm run test:live                            # live LLM tests (R5, R6, R7.3, R8, R10) — uses API credits
.venv/bin/python tests/e2e.py                             # R11, about 3 minutes
```
