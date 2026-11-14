// T5.7 reducer unit tests and T10.1/T10.2 metrics tests. No LLM, no network.
//   cd agents && npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyOps, emptyState, type Op } from '../src/state.ts'
import { computeMetrics } from '../src/metrics.ts'

const blank: Op = {
  op: 'add_patient', patient_id: null, request_id: null, age_group: null, triage: null, floor: null, location: null,
  conditions: null, note: null, status: null, assigned_to: null, destination: null, eta_min: null, kind: null,
  category: null, quantity: null, description: null, address: null,
}
const op = (o: Partial<Op>): Op => ({ ...blank, ...o })
const T0 = 1_000_000

function scripted() {
  let s = emptyState('test', T0)
  s = applyOps(s, [op({ op: 'set_incident', address: '412 Oak Street' }),
    op({ op: 'add_hazard', kind: 'smoke', description: 'heavy smoke', floor: 3 })], 'FIRE-CPT-1', T0).state
  s = applyOps(s, [op({ op: 'add_patient', age_group: 'adult', triage: 'red', floor: 3, conditions: ['not breathing'] }),
    op({ op: 'add_patient', age_group: 'child', triage: 'yellow', floor: 3, conditions: ['conscious', 'cough'] })], 'FIRE-CPT-1', T0 + 20).state
  s = applyOps(s, [op({ op: 'update_patient', patient_id: 'P1', assigned_to: 'MED-1', status: 'treating',
    conditions: ['burns to both arms'], note: 'airway started' })], 'MED-1', T0 + 40).state
  s = applyOps(s, [op({ op: 'add_hazard', kind: 'road_blocked', description: 'Oak and 3rd blocked by debris', location: 'Oak and 3rd' }),
    op({ op: 'add_request', kind: 'reroute', category: 'action', description: 'reroute units via Pine' })], 'PD-1', T0 + 60).state
  s = applyOps(s, [op({ op: 'add_request', kind: 'ambulance', category: 'resource', description: 'second ambulance' }),
    op({ op: 'add_request', kind: 'ladder_truck', category: 'resource', description: 'ladder truck' })], 'FIRE-CPT-1', T0 + 75).state
  s = applyOps(s, [op({ op: 'update_patient', patient_id: 'P1', status: 'transporting', destination: 'Valley Care ER', eta_min: 8 })], 'MED-1', T0 + 140).state
  return s
}

test('T5.7a add_patient creates ids P1, P2 with triage history', () => {
  const s = scripted()
  assert.deepEqual(s.patients.map((p) => [p.id, p.triage, p.floor, p.age_group]), [['P1', 'red', 3, 'adult'], ['P2', 'yellow', 3, 'child']])
  assert.equal(s.address, '412 Oak Street')
})

test('T5.7b update_patient updates in place, never duplicates', () => {
  const s = scripted()
  assert.equal(s.patients.length, 2)
  const p1 = s.patients[0]
  assert.equal(p1.assigned_to, 'MED-1')
  assert.ok(p1.conditions.includes('burns to both arms'))
  assert.ok(p1.notes.includes('airway started'))
  assert.equal(p1.status, 'transporting')
  assert.equal(p1.destination, 'Valley Care ER')
  assert.equal(p1.eta_min, 8)
})

test('T5.7c unknown patient id is dropped, not created', () => {
  const r = applyOps(scripted(), [op({ op: 'update_patient', patient_id: 'P9', triage: 'red' })], 'X', T0)
  assert.equal(r.state.patients.length, 2)
  assert.equal(r.changes[0].kind, 'skipped')
})

test('T5.7d correction changes yellow to red and records it', () => {
  const r = applyOps(scripted(), [op({ op: 'update_patient', patient_id: 'P2', triage: 'red', conditions: ['not breathing'] })], 'FIRE-CPT-1', T0 + 150)
  const p2 = r.state.patients[1]
  assert.equal(p2.triage, 'red')
  assert.deepEqual(p2.triage_history.map((h) => h.to), ['yellow', 'red'])
  assert.match(r.changes[0].text, /YELLOW → RED/)
})

test('T5.7e duplicate hazard and duplicate open request are skipped', () => {
  const s = scripted()
  const r = applyOps(s, [op({ op: 'add_hazard', kind: 'smoke', description: 'smoke again', floor: 3 }),
    op({ op: 'add_request', kind: 'ladder_truck', description: 'ladder truck' })], 'FIRE-CPT-1', T0 + 100)
  assert.equal(r.state.hazards.length, s.hazards.length)
  assert.equal(r.state.requests.length, s.requests.length)
})

test('T5.7f close_request marks fulfilled', () => {
  const r = applyOps(scripted(), [op({ op: 'close_request', request_id: 'R3' })], 'DISPATCH', T0 + 120)
  assert.equal(r.state.requests[2].status, 'fulfilled')
})

test('T5.7g reroute is an action, not a resource request', () => {
  const s = scripted()
  assert.equal(s.requests[0].kind, 'reroute')
  assert.equal(s.requests[0].category, 'action')
})

test('T10.1 metrics: 1 red, 1 yellow, 2 open requests, 1 mayday, 1 ack', () => {
  const events = [
    { type: 'fall', ts: T0 + 90 }, { type: 'mayday', ts: T0 + 106, fell_at: T0 + 90, responder: 'FIRE-CPT-1' },
    { type: 'fall', ts: T0 + 120 }, { type: 'ack', ts: T0 + 128, fell_at: T0 + 120, responder: 'FIRE-CPT-1' },
  ]
  const m = computeMetrics(scripted(), events, T0 + 160)
  assert.deepEqual(m.triage_counts, { red: 1, yellow: 1, green: 0, black: 0, untriaged: 0 })
  assert.equal(m.open_requests.length, 2)
  assert.deepEqual(m.open_requests.map((r) => r.description), ['second ambulance', 'ladder truck'])
  assert.equal(m.actions.length, 1)
  assert.equal(m.maydays, 1)
  assert.equal(m.acks, 1)
  assert.equal(m.falls, 2)
  assert.equal(m.duration_s, 160)
})

test('T10.4 fall outcomes: mayday never acknowledged vs ack before mayday', () => {
  const events = [
    { type: 'fall', ts: T0 + 90, at: T0 + 90, responder: 'FIRE-CPT-1' }, { type: 'mayday', ts: T0 + 106, fell_at: T0 + 90, responder: 'FIRE-CPT-1' },
    { type: 'fall', ts: T0 + 120, at: T0 + 120, responder: 'FIRE-CPT-1' }, { type: 'ack', ts: T0 + 128, fell_at: T0 + 120, responder: 'FIRE-CPT-1' },
  ]
  const m = computeMetrics(scripted(), events, T0 + 160)
  assert.match(m.fall_outcomes[0].outcome, /MAYDAY after 16s — never acknowledged/)
  assert.match(m.fall_outcomes[1].outcome, /acknowledged by double-tap after 8s — no mayday/)
})

test('T10.2 metrics: response times', () => {
  const events = [{ type: 'mayday', ts: T0 + 106, fell_at: T0 + 90, responder: 'FIRE-CPT-1' },
    { type: 'ack', ts: T0 + 128, fell_at: T0 + 120, responder: 'FIRE-CPT-1' }]
  const m = computeMetrics(scripted(), events, T0 + 160)
  const t = Object.fromEntries(m.response_times.map((r) => [r.label, r.seconds]))
  assert.equal(t['P1 reported → care assigned (MED-1)'], 20)
  assert.equal(t['P1 reported → transporting'], 120)
  assert.equal(t['FIRE-CPT-1 fall → mayday'], 16)
  assert.equal(t['FIRE-CPT-1 fall → acknowledged'], 8)
  assert.equal(m.open_requests[0].open_for_s, 85)
})
