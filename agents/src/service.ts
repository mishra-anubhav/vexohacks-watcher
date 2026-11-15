// Agents service: receives every bus event, runs the agents, posts results back to the bus.
//
//   transcript  -> intake agent -> applyOps -> incident_state + board_change
//                  new patient       -> vision agent on the current camera frame
//                  patient transporting -> comms agent pre-alert -> speech
//   mayday/ack  -> alert + speech
//   coach       -> patient assigned / new hazard / unassigned patient -> advisory prompt + speech
//   incident_end -> post-incident workflow -> report
//
// Endpoints: POST /event   GET /state   GET /health   GET /audio/<f>   GET /frames/<f>
import { createServer } from 'node:http'
import { createReadStream, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { BUS, FRAMES_DIR, AUDIO_DIR, INCIDENTS_DIR, PORT, MODELS, COACH, FAST } from './config.ts'
import { applyOps, emptyState, summarizeForAgent, OpsSchema, type IncidentState, type Alert, type CoachPrompt } from './state.ts'
import { triggersFromUpdate, findNudges, nudgeText, isIncidentQuestion, type CoachTrigger } from './coach.ts'
import { CoachSchema, QuestionSchema } from './mastra/agents/coach.ts'
import { readFileSync } from 'node:fs'
import { ROOT } from './config.ts'
import type { BusEvent } from './metrics.ts'
import { synthesize, playLocally, speechStatus, spokenBetween } from './speech.ts'
import { stripEcho } from './echo.ts'
import { mastra } from './mastra/index.ts'

mkdirSync(FRAMES_DIR, { recursive: true })
mkdirSync(INCIDENTS_DIR, { recursive: true })

const intake = mastra.getAgent('intakeAgent')
const vision = mastra.getAgent('visionAgent')
const comms = mastra.getAgent('commsAgent')
const coach = mastra.getAgent('coachAgent')
const coached = new Set<string>()
const SELF = `http://127.0.0.1:${PORT}`

let state: IncidentState = emptyState()
let events: BusEvent[] = []
const prealerted = new Set<string>()
const visionDone = new Set<string>()
let stopped = false                                    // after Stop: agents stop listening until a new incident
let queue: Promise<unknown> = Promise.resolve()        // transcripts are applied strictly in order
const stats = { echo_removed: 0, transcripts: 0, intake_ms: [] as number[], vision_ms: [] as number[], errors: [] as string[] }

const now = () => Date.now() / 1000

// What the body-cam video says (transcribed once with Deepgram): when its sound plays on the
// speakers, the band hears it too. Words within ~14 s before the video's current position count as echo.
let videoWords: { w: string; start: number }[] = [], videoDuration = 0
try {
  const v = JSON.parse(readFileSync(join(ROOT, 'media', 'helmetcam.words.json'), 'utf8'))
  videoWords = v.words; videoDuration = v.duration
} catch { /* no video transcript: only our own speech is filtered */ }
async function videoSpeechNearNow(): Promise<string[]> {
  if (!videoWords.length) return []
  try {
    const s = (await (await fetch(`${BUS}/status`)).json()) as { video_pos: number | null; video_url: string | null }
    if (s.video_pos == null || !s.video_url) return []
    const near = (t: number) => { const d = (s.video_pos! - t + videoDuration) % videoDuration; return d <= 14 || d >= videoDuration - 1 }
    const words = videoWords.filter((x) => near(x.start)).map((x) => x.w)
    return words.length ? [words.join(' ')] : []
  } catch { return [] }
}
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a)

async function post(event: Record<string, unknown>) {
  try {
    const r = await fetch(`${BUS}/events`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Board-Token': process.env.BOARD_TOKEN ?? '' },   // hosted board: operator key
      body: JSON.stringify({ source: 'agents', ts: now(), ...event }) })
    if (!r.ok) { stats.errors.push(`bus refused ${event.type}: ${r.status}`); log(`bus refused ${event.type}: ${r.status}`) }
  } catch (e) {
    log('bus not reachable:', String(e))
  }
}
const publishState = () => post({ type: 'incident_state', state })

function addAlert(a: Omit<Alert, 'id' | 'ts'>): Alert {
  const alert: Alert = { id: `A${state.alerts.length + 1}`, ts: now(), ...a }
  state.alerts.push(alert)
  state.timeline.push({ ts: alert.ts, who: 'SYSTEM', kind: `alert_${a.kind}`, text: a.text })
  return alert
}

async function speak(alert: Alert, style: string, spokenText = alert.text, urgent = false) {
  try {
    const s = await synthesize(spokenText, style, urgent ? 'urgent' : 'calm')
    alert.audio = `/agents/audio/${s.name}`
    await post({ type: 'speech', alert_id: alert.id, kind: alert.kind, text: spokenText, url: alert.audio, provider: s.provider })
    publishState()
    playLocally(s.file, urgent, spokenText)
  } catch (e) {
    stats.errors.push(`speech: ${String(e)}`)
    log('speech failed:', String(e))
  }
}

// ---- transcript -> intake agent ---------------------------------------------------------

async function handleTranscript(e: BusEvent) {
  const who = e.responder ?? 'UNKNOWN'
  let text = String(e.text ?? '').trim()
  if (e.source === 'band') {                     // drop what the band heard from our own speakers
    const echo = stripEcho(text, [...spokenBetween(e.ts - 45, e.ts), ...(await videoSpeechNearNow())])
    if (echo.removed) {
      log(`echo guard: removed ${echo.removed} words from "${text}" -> "${echo.text}"`)
      stats.echo_removed += echo.removed
      await post({ type: 'echo_removed', original: text, kept: echo.text, removed: echo.removed })
      text = echo.text
    }
  }
  if (!text) return
  if (isIncidentQuestion(text)) void runCoach({ kind: 'question', key: `q:${e.ts}`, to: who, question: text })   // don't wait for intake
  const recent = state.transcript.slice(-4).map((t) => `${t.who}: ${t.text}`).join('\n') || '(none)'
  state.transcript.push({ ts: e.ts, who, text })
  stats.transcripts++
  const t0 = Date.now()
  let ops
  try {
    const r = await intake.generate(
      `CURRENT BOARD\n${summarizeForAgent(state)}\n\nRECENT RADIO\n${recent}\n\nNEW UTTERANCE\n${who}: "${text}"`,
      { structuredOutput: { schema: OpsSchema }, ...FAST } as any)
    ops = (r.object as { ops: any[] }).ops
  } catch (err) {
    stats.errors.push(`intake: ${String(err)}`)
    log('intake failed:', String(err))
    return
  }
  stats.intake_ms.push(Date.now() - t0)
  const before = new Map(state.patients.map((p) => [p.id, p.status]))
  const prev = state
  const result = applyOps(state, ops, who, e.ts)
  state = result.state
  log(`intake ${Date.now() - t0}ms ${who}: "${text}" ->`, result.changes.map((c) => c.text).join(' | ') || 'no change')
  if (!result.changes.some((c) => c.kind !== 'skipped')) return
  for (const c of result.changes) if (c.kind !== 'skipped') await post({ type: 'board_change', change: c.kind, text: c.text, id: c.id, responder: who })
  await publishState()

  for (const p of state.patients) {
    if (!before.has(p.id) && !visionDone.has(p.id)) { visionDone.add(p.id); void describePatient(p.id) }
    if (p.status === 'transporting' && before.get(p.id) !== 'transporting' && !prealerted.has(p.id)) {
      prealerted.add(p.id)
      void prealert(p.id)
    }
  }
  for (const t of triggersFromUpdate(prev, state)) void runCoach(t)
}

// ---- coach agent: next-step guidance for junior responders -------------------------------

async function runCoach(t: CoachTrigger) {
  if (stopped || coached.has(t.key)) return
  coached.add(t.key)
  const incident = state.incident_id
  const t0 = Date.now()
  try {
    let advice: { priority: CoachPrompt['priority']; message: string; steps: string[] }
    if (t.kind === 'nudge') {
      advice = { priority: 'task', ...nudgeText(t) }
    } else if (t.kind === 'question') {
      const recent = state.transcript.slice(-4).map((x) => `${x.who}: ${x.text}`).join('\n') || '(none)'
      const r = await coach.generate(`TRIGGER\nQuestion from ${t.to}: "${t.question}"\n\nTALKING TO: ${t.to}\n\nRECENT RADIO\n${recent}\n\nINCIDENT BOARD\n${summarizeForAgent(state)}`,
        { structuredOutput: { schema: QuestionSchema }, ...FAST } as any)
      const o = r.object as { relevant: boolean; message: string; steps: string[] }
      if (!o.relevant) { log(`coach: not answering side question "${t.question}"`); return }
      advice = { priority: 'task', message: o.message, steps: o.steps }
    } else {
      const what = t.kind === 'assigned'
        ? `${t.to} has just been assigned patient ${t.patient.id}: ${t.patient.age_group}, triage ${t.patient.triage ?? 'none'}, floor ${t.patient.floor ?? '?'}, ` +
          `conditions: ${t.patient.conditions.join(', ') || 'none'}; notes: ${t.patient.notes.join(', ') || 'none'}.` +
          (t.patient.vision ? ` Body camera when reported: ${t.patient.vision}` : '')
        : `New hazard reported by ${t.hazard.reported_by}: ${t.hazard.kind} — ${t.hazard.description}` +
          (t.hazard.floor !== null ? `, floor ${t.hazard.floor}` : '') + (t.hazard.location ? ` @ ${t.hazard.location}` : '') + '. Talking to all crews.'
      const r = await coach.generate(`TRIGGER
${what}

TALKING TO: ${t.to}

INCIDENT BOARD
${summarizeForAgent(state)}`,
        { structuredOutput: { schema: CoachSchema }, ...FAST } as any)
      advice = { ...(r.object as { message: string; steps: string[] }), priority: t.kind === 'assigned' ? 'patient' : 'safety' }
    }
    if (state.incident_id !== incident) return
    const prompt: CoachPrompt = { id: `C${state.coaching.length + 1}`, ts: now(), to: t.to, trigger: t.kind, key: t.key,
      priority: advice.priority, message: advice.message.trim(), steps: advice.steps.slice(0, 4), audio: null }
    state.coaching.push(prompt)
    state.timeline.push({ ts: prompt.ts, who: 'COACH', kind: 'coach', text: `→ ${t.to} (${t.kind}): ${prompt.message}` })
    log(`coach ${Date.now() - t0}ms → ${t.to} [${t.kind}] ${prompt.message}`)
    await post({ type: 'coach', prompt })
    await publishState()
    if (COACH.speak) {
      const s = await synthesize(`${t.to === 'ALL' ? 'All crews' : t.to.replace(/-/g, ' ')}. ${prompt.message}`, 'coach', 'coach')
      prompt.audio = `/agents/audio/${s.name}`
      await post({ type: 'speech', kind: 'coach', text: prompt.message, url: prompt.audio, provider: s.provider })
      await publishState()
      playLocally(s.file, false, `${t.to === 'ALL' ? 'All crews' : t.to.replace(/-/g, ' ')}. ${prompt.message}`)
    }
  } catch (err) {
    stats.errors.push(`coach: ${String(err)}`)
    log('coach failed:', String(err))
  }
}

setInterval(() => {
  if (!state.started || stopped) return
  for (const t of findNudges(state, now(), COACH.nudgeAfterS, COACH.commander)) void runCoach(t)
}, 2000)

// ---- vision agent on the current frame --------------------------------------------------

async function describePatient(id: string) {
  const incident = state.incident_id
  const t0 = Date.now()
  try {
    const r = await fetch(`${BUS}/frame.jpg`)
    if (!r.ok) throw new Error(`no frame (${r.status})`)
    const jpg = Buffer.from(await r.arrayBuffer())
    const name = `${incident ?? 'x'}-${id}.jpg`
    writeFileSync(join(FRAMES_DIR, name), jpg)
    const p0 = state.patients.find((p) => p.id === id)
    const said = p0 ? `${p0.age_group}, triage ${p0.triage ?? 'none'}, ${p0.conditions.join(', ')}` : ''
    const res = await vision.generate([{ role: 'user', content: [
      { type: 'image', image: jpg.toString('base64'), mimeType: 'image/jpeg' },
      { type: 'text', text: `Casualty just reported by radio: ${said}. Describe what this helmet-cam frame shows.` },
    ] }])
    if (state.incident_id !== incident) return                       // a new incident started meanwhile
    const p = state.patients.find((x) => x.id === id)
    if (!p) return
    p.image = `/agents/frames/${name}`
    p.vision = res.text.trim().replace(/\s+/g, ' ')
    stats.vision_ms.push(Date.now() - t0)
    state.timeline.push({ ts: now(), who: 'VISION', kind: 'vision', text: `${id} camera: ${p.vision}` })
    log(`vision ${Date.now() - t0}ms ${id}: ${p.vision}`)
    await post({ type: 'board_change', change: 'vision', id, text: `${id} camera: ${p.vision}` })
    await publishState()
  } catch (err) {
    stats.errors.push(`vision: ${String(err)}`)
    log('vision failed:', String(err))
  }
}

// ---- comms agent: hospital pre-alert ----------------------------------------------------

async function prealert(id: string) {
  const p = state.patients.find((x) => x.id === id)
  if (!p) return
  try {
    const facts = { hospital: p.destination, eta_min: p.eta_min, age_group: p.age_group, triage: p.triage,
      conditions: p.conditions, notes: p.notes, treating_unit: p.assigned_to, camera: p.vision, mechanism: 'structure fire, smoke' }
    const r = await comms.generate(`Write the pre-alert for this patient: ${JSON.stringify(facts)}`)
    const text = r.text.trim()
    const alert = addAlert({ kind: 'prealert', severity: 'warning', text, patient_id: id })
    await post({ type: 'alert', alert })
    await publishState()
    await speak(alert, 'Say clearly, like a calm dispatcher')
  } catch (err) {
    stats.errors.push(`prealert: ${String(err)}`)
    log('prealert failed:', String(err))
  }
}

// ---- safety alerts ----------------------------------------------------------------------

async function handleSafety(e: BusEvent) {
  const who = e.responder ?? 'responder'
  const where = state.address ?? 'the incident'
  if (e.type === 'fall') {
    state.timeline.push({ ts: e.ts, who, kind: 'fall', text: `${who} fall detected` })
  } else if (e.type === 'still') {
    state.timeline.push({ ts: e.ts, who, kind: 'still', text: `${who} no movement — countdown started` })
  } else if (e.type === 'cancel') {
    state.timeline.push({ ts: e.ts, who, kind: 'cancel', text: `${who} moving again — alarm cancelled` })
  } else if (e.type === 'mayday') {
    const words = String(e.last_words ?? '').trim()
    const short = words.split(/\s+/).slice(-25).join(' ')
    const alert = addAlert({ kind: 'mayday', severity: 'critical',
      text: `MAYDAY: ${who} down at ${where}, no movement after a fall. Last words: ${words || '(nothing heard)'}` })
    await post({ type: 'alert', alert })
    await publishState()
    await speak(alert, 'Say urgently and clearly, like an emergency dispatcher',
      `Mayday, mayday, mayday. ${who.replace(/-/g, ' ')} is down at ${where}. No movement after a fall.` + (short ? ` Last words heard: ${short}` : ''), true)
    return
  } else if (e.type === 'ack') {
    const alert = addAlert({ kind: 'ack', severity: 'info', text: `${who} acknowledged — responder OK. No mayday sent.` })
    await post({ type: 'alert', alert })
    await publishState()
    await speak(alert, 'Say calmly', `${who.replace(/-/g, ' ')} acknowledged. Responder OK.`)
    return
  }
  await publishState()
}

// ---- post-incident workflow -------------------------------------------------------------

async function endIncident() {
  const t0 = Date.now()
  await post({ type: 'report_status', status: 'running' })
  try {
    const run = await mastra.getWorkflow('postIncidentWorkflow').createRun()
    const res: any = await run.start({ inputData: { state, events, ended: now() } })
    if (res.status !== 'success') throw new Error(`workflow ${res.status}`)
    const { metrics, analysis, markdown } = res.result
    const base = join(INCIDENTS_DIR, `${state.incident_id ?? 'incident'}-report`)
    writeFileSync(base + '.md', markdown)
    writeFileSync(base + '.json', JSON.stringify({ metrics, analysis, state }, null, 2))
    log(`report ${Date.now() - t0}ms -> ${base}.md`)
    await post({ type: 'report', markdown, metrics, analysis, file: base + '.md' })
  } catch (err) {
    stats.errors.push(`report: ${String(err)}`)
    log('report failed:', String(err))
    await post({ type: 'report_status', status: 'failed', error: String(err) })
  }
}

// ---- dispatch ---------------------------------------------------------------------------

function onEvent(e: BusEvent) {
  if (e.type === 'incident_started') {
    state = emptyState(String(e.incident_id ?? ''), e.ts)
    events = [e]
    prealerted.clear(); visionDone.clear(); coached.clear(); stopped = false
    stats.transcripts = 0; stats.intake_ms = []; stats.vision_ms = []; stats.errors = []
    queue = Promise.resolve()
    log('incident started', state.incident_id)
    void publishState()
    return
  }
  if (e.type === 'incident_stopped') {
    stopped = true
    state.timeline.push({ ts: e.ts, who: 'COMMAND', kind: 'stopped', text: 'Incident stopped — agents stopped listening' })
    events.push(e)
    log('incident stopped')
    void publishState()
    return
  }
  if (!state.started) state = emptyState(String(e.incident_id ?? ''), e.ts)
  events.push(e)
  if (stopped && e.type !== 'incident_end') return          // stopped: keep the log, run no agents (report still allowed)
  if (e.type === 'transcript' && e.final !== false) queue = queue.then(() => handleTranscript(e))
  else if (['fall', 'still', 'cancel', 'mayday', 'ack'].includes(e.type)) queue = queue.then(() => handleSafety(e))
  else if (e.type === 'incident_end') queue = queue.then(() => endIncident())
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', SELF)
  const send = (code: number, body: unknown, type = 'application/json') => {
    res.writeHead(code, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' })
    res.end(typeof body === 'string' ? body : JSON.stringify(body))
  }
  if (req.method === 'POST' && url.pathname === '/event') {
    let body = ''
    for await (const chunk of req) body += chunk
    try {
      onEvent(JSON.parse(body))
      return send(204, '')
    } catch {
      return send(400, { error: 'bad event' })
    }
  }
  if (url.pathname === '/state') return send(200, state)
  if (url.pathname === '/health') {
    if (url.searchParams.has('wait')) await queue          // ?wait: answer once all queued work is done
    return send(200, { ok: true, models: MODELS, speech: speechStatus(), ...stats })
  }
  for (const [prefix, dir, type] of [['/audio/', AUDIO_DIR, ''], ['/frames/', FRAMES_DIR, 'image/jpeg']] as const) {
    if (url.pathname.startsWith(prefix)) {
      const file = join(dir, basename(url.pathname))
      if (!existsSync(file)) return send(404, 'not found', 'text/plain')
      res.writeHead(200, { 'Content-Type': type || (file.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav'), 'Access-Control-Allow-Origin': '*' })
      return createReadStream(file).pipe(res)
    }
  }
  send(404, { error: 'not found' })
})

server.listen(PORT, process.env.AGENTS_HOST ?? '127.0.0.1', () => {
  log(`agents service http://127.0.0.1:${PORT}  bus ${BUS}  models ${JSON.stringify(MODELS)}  speech ${JSON.stringify(speechStatus())}`)
})
