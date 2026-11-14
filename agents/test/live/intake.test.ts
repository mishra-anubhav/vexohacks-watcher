// T5.1–T5.6: the intake agent on the script lines and edge cases, through the real model.
//   cd agents && npm run test:live      (uses OpenAI credits)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mastra } from '../../src/mastra/index.ts'
import { FAST } from '../../src/config.ts'
import { applyOps, emptyState, summarizeForAgent, OpsSchema, type IncidentState } from '../../src/state.ts'

const intake = mastra.getAgent('intakeAgent')
let s: IncidentState = emptyState('live-test', 0)
const said: string[] = []
let t = 0

async function hear(who: string, text: string) {
  const recent = said.slice(-4).join('\n') || '(none)'
  said.push(`${who}: ${text}`)
  const r = await intake.generate(`CURRENT BOARD\n${summarizeForAgent(s)}\n\nRECENT RADIO\n${recent}\n\nNEW UTTERANCE\n${who}: "${text}"`,
    { structuredOutput: { schema: OpsSchema }, ...FAST } as any)
  const out = applyOps(s, (r.object as any).ops, who, (t += 10))
  s = out.state
  console.log(`  ${who}: ${text}\n    -> ${out.changes.map((c) => c.text).join(' | ') || '(no change)'}`)
  return out.changes
}
const has = (re: RegExp, xs: string[]) => xs.some((x) => re.test(x.toLowerCase()))

test('T5.1 line 1 -> smoke hazard on floor 3, address', async () => {
  await hear('FIRE-CPT-1', 'Engine 2 on scene, 412 Oak Street, heavy smoke from the third floor.')
  const smoke = s.hazards.find((h) => /smoke/.test(h.kind + h.description))
  assert.ok(smoke, 'no smoke hazard')
  assert.equal(smoke.floor, 3)
  assert.match(s.address ?? '', /412 Oak/i)
  assert.equal(s.patients.length, 0)
})

test('T5.2 line 2 -> two patients, red + yellow, floor 3', async () => {
  await hear('FIRE-CPT-1', 'Two victims on floor 3. One adult not breathing, one child conscious with a cough.')
  assert.equal(s.patients.length, 2)
  const adult = s.patients.find((p) => p.age_group === 'adult')
  const child = s.patients.find((p) => p.age_group === 'child')
  assert.equal(adult?.triage, 'red')
  assert.equal(child?.triage, 'yellow')
  assert.equal(adult?.floor, 3)
  assert.equal(child?.floor, 3)
})

test('T5.3 MED-1 takes the red patient -> same patient updated, no duplicate', async () => {
  await hear('MED-1', 'Medic 1 taking the red patient, burns to both arms, starting airway.')
  assert.equal(s.patients.length, 2)
  const red = s.patients.find((p) => p.age_group === 'adult')!
  assert.equal(red.triage, 'red')
  assert.equal(red.assigned_to, 'MED-1')
  assert.ok(has(/burn/, [...red.conditions, ...red.notes]), 'burns not recorded')
  assert.ok(has(/airway/, [...red.conditions, ...red.notes]), 'airway not recorded')
})

test('T5.4 PD-1 -> road blocked hazard + reroute action', async () => {
  await hear('PD-1', 'Oak and 3rd is blocked by debris, reroute units via Pine.')
  assert.ok(s.hazards.some((h) => /road|block/.test(h.kind + ' ' + h.description.toLowerCase())), 'no road-blocked hazard')
  const reroute = s.requests.find((r) => r.kind === 'reroute')
  assert.ok(reroute, 'no reroute')
  assert.equal(reroute.category, 'action')
})

test('T5.5 line 5 -> two open resource requests (ambulance, ladder)', async () => {
  await hear('FIRE-CPT-1', 'Requesting a second ambulance and a ladder truck.')
  const open = s.requests.filter((r) => r.category === 'resource' && r.status === 'open')
  assert.equal(open.length, 2)
  assert.ok(open.some((r) => /ambulance/.test(r.kind + r.description)))
  assert.ok(open.some((r) => /ladder/.test(r.kind + r.description)))
})

test('T5.6 correction -> child yellow to red, still 2 patients', async () => {
  await hear('FIRE-CPT-1', 'Correction, the child is not breathing either.')
  assert.equal(s.patients.length, 2)
  assert.equal(s.patients.find((p) => p.age_group === 'child')?.triage, 'red')
})

test('T8.1 transport line -> transporting, Valley Care, ETA 8', async () => {
  await hear('MED-1', 'Red patient transporting to Valley Care ER, ETA 8 minutes.')
  const adult = s.patients.find((p) => p.age_group === 'adult')!
  assert.equal(adult.status, 'transporting')
  assert.match(adult.destination ?? '', /valley care/i)
  assert.equal(adult.eta_min, 8)
  assert.equal(s.patients.length, 2)
})

test('T5.8 split transcript (as Deepgram delivers it) -> no duplicates', async () => {
  s = emptyState('split', 0); said.length = 0
  await hear('FIRE-CPT-1', 'Two victims on Floor 3,')
  await hear('FIRE-CPT-1', 'one adult not breathing, one child conscious with a cough,')
  assert.equal(s.patients.length, 2, `expected 2 patients, board:\n${summarizeForAgent(s)}`)
  assert.deepEqual(s.patients.map((p) => p.triage).sort(), ['red', 'yellow'])
})

test('T5.9 noise / chatter -> no board change', async () => {
  const before = JSON.stringify([s.patients, s.hazards, s.requests])
  await hear('FIRE-CPT-1', 'Copy that. Hey, can somebody pass me the water bottle?')
  assert.equal(JSON.stringify([s.patients, s.hazards, s.requests]), before)
})
