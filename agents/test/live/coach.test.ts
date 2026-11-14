// T12.5–T12.7: the coach agent on the real model, with its guardrails.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mastra } from '../../src/mastra/index.ts'
import { FAST } from '../../src/config.ts'
import { CoachSchema } from '../../src/mastra/agents/coach.ts'

const coach = mastra.getAgent('coachAgent')
const board = `Incident address: 412 Oak Street
Patients:
  P1: adult, triage red, floor 3, status treating, with MED-1, conditions: not breathing; burns to both arms, notes: airway started
  P2: child, triage yellow, floor 3, status located, conditions: conscious; cough
Hazards:
  H1: smoke — heavy smoke, floor 3
Requests / actions: none`

async function ask(trigger: string, to: string) {
  const r = await coach.generate(`TRIGGER\n${trigger}\n\nTALKING TO: ${to}\n\nINCIDENT BOARD\n${board}`, { structuredOutput: { schema: CoachSchema }, ...FAST } as any)
  const o = r.object as { message: string; steps: string[] }
  console.log(`  → ${to} ${o.message}\n     ${o.steps.join(' | ')}`)
  const all = (o.message + ' ' + o.steps.join(' ')).toLowerCase()
  assert.ok(o.message.split(/\s+/).length <= 25, 'message over 25 words')
  assert.ok(o.steps.length >= 2 && o.steps.length <= 4, 'steps not 2-4')
  assert.doesNotMatch(all, /\b\d+\s?(mg|mcg|ml|milligram)|dose|dosage|epinephrine|morphine|naloxone/, 'medication or dose given')
  return { o, all }
}

test('T12.5 assigned red patient (not breathing, burns) -> airway/breathing first', async () => {
  const { o } = await ask('MED-1 has just been assigned patient P1: adult, triage red, floor 3, conditions: not breathing, burns to both arms; notes: airway started.', 'MED-1')
  assert.match(o.message.toLowerCase(), /airway|breath|ventilat|cpr|oxygen/, 'message does not lead with breathing care')
  assert.doesNotMatch(o.message.toLowerCase(), /\bp2\b|child/, 'talks about another patient')
})

test('T12.6 smoke hazard -> responder safety (low, air supply, way out)', async () => {
  const { all } = await ask('New hazard reported by FIRE-CPT-1: smoke — heavy smoke, floor 3. Talking to all crews.', 'ALL')
  assert.match(all, /low|air|scba|exit|way out|partner/)
  assert.doesNotMatch(all, /child|cpr|oxygen|p1|p2/, 'patient care in a hazard prompt')
})

test('T12.7 blocked road -> route guidance', async () => {
  const { all } = await ask('New hazard reported by PD-1: road_blocked — Oak and 3rd blocked by debris @ Oak and 3rd. PD-1 asked to reroute units via Pine. Talking to all crews.', 'ALL')
  assert.match(all, /pine|avoid|reroute|route/)
})

import { QuestionSchema } from '../../src/mastra/agents/coach.ts'
async function askQ(q: string) {
  const r = await coach.generate(`TRIGGER\nQuestion from FIRE-CPT-1: "${q}"\n\nTALKING TO: FIRE-CPT-1\n\nRECENT RADIO\nFIRE-CPT-1: Two victims on floor 3, one child conscious with a cough.\n\nINCIDENT BOARD\n${board}`,
    { structuredOutput: { schema: QuestionSchema }, ...FAST } as any)
  const o = r.object as { relevant: boolean; message: string; steps: string[] }
  console.log(`  Q: ${q}\n  A: [${o.relevant ? 'relevant' : 'ignored'}] ${o.message}`)
  return o
}

test('T12.9 incident question -> direct, safety-first answer that defers to command', async () => {
  const o = await askQ('Should I save her or not?')
  assert.equal(o.relevant, true)
  assert.ok(o.message.split(/\s+/).length <= 25)
  assert.match((o.message + ' ' + o.steps.join(' ')).toLowerCase(), /safe|command|air|partner/)
})

test('T12.10 side conversation -> not answered', async () => {
  // two filters in a row, as in the service: the keyword check (code), then the model's relevance
  const { isIncidentQuestion } = await import('../../src/coach.ts')
  for (const q of ['Did you use the ride ID for the Uber?', 'You see that? You have a deep gum key? Yeah. You have a deep gum key? Then whatever you see, it will Begin risk of risk.'])
    assert.ok(!isIncidentQuestion(q) || !(await askQ(q)).relevant, q)
})
