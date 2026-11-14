// T6.1 vision agent, T7.3 speech, T8.2 comms pre-alert text, T10.3 post-incident workflow.
//   cd agents && npm run test:live
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mastra } from '../../src/mastra/index.ts'
import { applyOps, emptyState, type Op } from '../../src/state.ts'
import { synthesize } from '../../src/speech.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

test('T6.1 vision agent describes a helmet-cam frame in <= 20 words', async (t) => {
  // a frame from the body-cam video (not in the repo: see README to download it, then
  // ffmpeg -ss 45 -i media/helmetcam.mp4 -frames:v 1 agents/test/live/frame45.jpg)
  if (!existsSync(join(HERE, 'frame45.jpg'))) return t.skip('no frame45.jpg (video not downloaded)')
  const jpg = readFileSync(join(HERE, 'frame45.jpg'))
  const r = await mastra.getAgent('visionAgent').generate([{ role: 'user', content: [
    { type: 'image', image: jpg.toString('base64'), mimeType: 'image/jpeg' },
    { type: 'text', text: 'Casualty just reported by radio: adult, red, not breathing. Describe what this frame shows.' }] }])
  const text = r.text.trim()
  console.log('  vision:', text)
  assert.ok(text.length > 0)
  assert.ok(text.split(/\s+/).length <= 20, `too long: ${text}`)
})

test('T7.3 speech: audio file is produced (ElevenLabs or Gemini fallback)', async () => {
  const s = await synthesize(`Test alert ${Date.now()}. Fire Captain 1 acknowledged.`, 'Say calmly')
  console.log('  speech provider:', s.provider, s.name)
  assert.ok(existsSync(s.file))
  assert.ok(statSync(s.file).size > 10_000)
})

test('T8.2 comms agent writes a pre-alert naming the hospital and ETA', async () => {
  const facts = { hospital: 'Valley Care ER', eta_min: 8, age_group: 'adult', triage: 'red',
    conditions: ['not breathing', 'burns to both arms'], notes: ['airway started'], treating_unit: 'MED-1', mechanism: 'structure fire, smoke' }
  const r = await mastra.getAgent('commsAgent').generate(`Write the pre-alert for this patient: ${JSON.stringify(facts)}`)
  console.log('  prealert:', r.text)
  assert.match(r.text, /valley care/i)
  assert.match(r.text, /\b8\b|eight/i)
  assert.ok(r.text.split(/\s+/).length <= 55)
})

test('T10.3 post-incident workflow: report has summary, numbers, timeline, recommendations', async () => {
  const blank: Op = { op: 'add_patient', patient_id: null, request_id: null, age_group: null, triage: null, floor: null, location: null,
    conditions: null, note: null, status: null, assigned_to: null, destination: null, eta_min: null, kind: null, category: null,
    quantity: null, description: null, address: null }
  const op = (o: Partial<Op>): Op => ({ ...blank, ...o })
  const T0 = 1_800_000_000
  let s = emptyState('wf-test', T0)
  s = applyOps(s, [op({ op: 'set_incident', address: '412 Oak Street' }), op({ op: 'add_hazard', kind: 'smoke', description: 'heavy smoke', floor: 3 })], 'FIRE-CPT-1', T0).state
  s = applyOps(s, [op({ op: 'add_patient', age_group: 'adult', triage: 'red', floor: 3 }), op({ op: 'add_patient', age_group: 'child', triage: 'yellow', floor: 3 })], 'FIRE-CPT-1', T0 + 20).state
  s = applyOps(s, [op({ op: 'update_patient', patient_id: 'P1', assigned_to: 'MED-1', status: 'treating' })], 'MED-1', T0 + 40).state
  s = applyOps(s, [op({ op: 'add_request', kind: 'ambulance', description: 'second ambulance' }), op({ op: 'add_request', kind: 'ladder_truck', description: 'ladder truck' })], 'FIRE-CPT-1', T0 + 75).state
  const events = [{ type: 'fall', ts: T0 + 90 }, { type: 'mayday', ts: T0 + 106, fell_at: T0 + 90, responder: 'FIRE-CPT-1' },
    { type: 'fall', ts: T0 + 120 }, { type: 'ack', ts: T0 + 128, fell_at: T0 + 120, responder: 'FIRE-CPT-1' }]
  const run = await mastra.getWorkflow('postIncidentWorkflow').createRun()
  const res: any = await run.start({ inputData: { state: s, events, ended: T0 + 160 } })
  assert.equal(res.status, 'success')
  const md: string = res.result.markdown
  console.log(md.split('\n').slice(0, 14).join('\n'))
  for (const h of ['## Summary', '## Key numbers', '## Response times', '## Timeline', '## Recommendations']) assert.ok(md.includes(h), `missing ${h}`)
  assert.match(md, /red 1, yellow 1/)
  assert.match(md, /1 mayday, 1 acknowledged/)
  assert.match(md, /Open resource requests: 2/)
  assert.ok(res.result.analysis.recommendations.length > 0)
})
