// T12.1–T12.4: when the coach speaks and to whom (no model).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyOps, emptyState, type Op } from '../src/state.ts'
import { triggersFromUpdate, findNudges, nudgeText } from '../src/coach.ts'

const blank: Op = { op: 'add_patient', patient_id: null, request_id: null, age_group: null, triage: null, floor: null, location: null,
  conditions: null, note: null, status: null, assigned_to: null, destination: null, eta_min: null, kind: null, category: null,
  quantity: null, description: null, address: null }
const op = (o: Partial<Op>): Op => ({ ...blank, ...o })
const T0 = 1_000_000

const s0 = emptyState('c', T0)
const s1 = applyOps(s0, [op({ op: 'add_hazard', kind: 'smoke', description: 'heavy smoke', floor: 3 })], 'FIRE-CPT-1', T0).state
const s2 = applyOps(s1, [op({ op: 'add_patient', age_group: 'adult', triage: 'red', floor: 3 }),
  op({ op: 'add_patient', age_group: 'child', triage: 'yellow', floor: 3 })], 'FIRE-CPT-1', T0 + 20).state
const s3 = applyOps(s2, [op({ op: 'update_patient', patient_id: 'P1', assigned_to: 'MED-1', status: 'treating' })], 'MED-1', T0 + 40).state

test('T12.1 new hazard -> one safety trigger to ALL', () => {
  const t = triggersFromUpdate(s0, s1)
  assert.deepEqual(t.map((x) => [x.kind, x.to, x.key]), [['hazard', 'ALL', 'hazard:H1']])
})

test('T12.2 patient assigned -> trigger to that unit; new unassigned patients -> none', () => {
  assert.deepEqual(triggersFromUpdate(s1, s2), [])
  const t = triggersFromUpdate(s2, s3)
  assert.deepEqual(t.map((x) => [x.kind, x.to, x.key]), [['assigned', 'MED-1', 'assigned:P1:MED-1']])
})

test('T12.3 nudge: only unassigned red/yellow, only after 60 s', () => {
  assert.equal(findNudges(s3, T0 + 79, 60, 'FIRE-CPT-1').length, 0)          // P2 reported at +20: 59 s
  const n = findNudges(s3, T0 + 81, 60, 'FIRE-CPT-1')
  assert.deepEqual(n.map((x) => [x.key, x.to]), [['nudge:P2', 'FIRE-CPT-1']]) // P1 is assigned: no nudge
})

test('T12.4 nudge text names the patient, colour and wait', () => {
  const n = findNudges(s3, T0 + 81, 60, 'FIRE-CPT-1')[0]
  assert.equal(n.kind, 'nudge')
  const t = nudgeText(n as any)
  assert.match(t.message, /P2, child, YELLOW, has had no one assigned for 61 seconds/)
  assert.match(t.steps[0], /floor 3/)
})

import { isQuestion, isIncidentQuestion } from '../src/coach.ts'
test('T12.11 only incident questions reach the coach', () => {
  for (const q of ['Should I save her or not?', 'Is the stairwell clear?', 'Where is the second ambulance?', 'Can I go in?']) assert.ok(isIncidentQuestion(q), q)
  for (const q of ['Did you use the ride ID?', 'You see that? You have a deep gum key? Then whatever you see, it will Begin risk of risk.',
    'Did you charge it?', 'Is it recording?']) assert.ok(!isIncidentQuestion(q), q)
})
test('T12.8 question detection', () => {
  for (const q of ['Should I save her or not?', 'Where is the second ambulance', 'Is the stairwell clear?']) assert.ok(isQuestion(q), q)
  for (const s of ['Two victims on floor 3.', 'Requesting a ladder truck.', 'Copy that.']) assert.ok(!isQuestion(s), s)
})
