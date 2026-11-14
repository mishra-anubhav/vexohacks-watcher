// When the coach speaks, and to whom. Pure functions, so they can be tested without a model.
import type { IncidentState, Patient, Hazard } from './state.ts'

export type CoachTrigger =
  | { kind: 'assigned'; key: string; to: string; patient: Patient }
  | { kind: 'hazard'; key: string; to: string; hazard: Hazard }
  | { kind: 'nudge'; key: string; to: string; patient: Patient; waited_s: number }
  | { kind: 'question'; key: string; to: string; question: string }

/** A responder asking something out loud ("Should I go in?"). Answered by the coach right away. */
export function isQuestion(text: string): boolean {
  const t = text.trim().toLowerCase()
  return t.includes('?') || /^(should|shall|can|could|do|does|is|are|what|where|how|which|who|when)\b/.test(t)
}

// Words a question about the incident almost always contains. A question without any of them
// ("You have a Deepgram key?") is side talk near the band and is not sent to the coach at all.
const INCIDENT_WORDS = /\b(patient|patients|victim|victims|child|kid|baby|adult|man|woman|she|he|her|him|them|they|fire|smoke|flame|floor|stair|stairs|stairwell|room|door|window|roof|exit|way out|air|scba|mask|tank|hazard|collapse|debris|road|route|ambulance|ladder|engine|hose|water|rescue|save|evacuate|search|breath|breathing|cpr|burn|burns|bleeding|pulse|triage|oxygen|airway|safe|unsafe|danger|command|go in|pull out|back out)\b/

/** A spoken question worth the coach's answer: a question, and about the incident. */
export function isIncidentQuestion(text: string): boolean {
  return isQuestion(text) && INCIDENT_WORDS.test(text.toLowerCase())
}

/** Triggers caused by one board update (before -> after). */
export function triggersFromUpdate(before: IncidentState, after: IncidentState): CoachTrigger[] {
  const out: CoachTrigger[] = []
  for (const p of after.patients) {
    const old = before.patients.find((x) => x.id === p.id)
    if (p.assigned_to && p.assigned_to !== old?.assigned_to) out.push({ kind: 'assigned', key: `assigned:${p.id}:${p.assigned_to}`, to: p.assigned_to, patient: p })
  }
  for (const h of after.hazards) {
    if (!before.hazards.some((x) => x.id === h.id)) out.push({ kind: 'hazard', key: `hazard:${h.id}`, to: 'ALL', hazard: h })
  }
  return out
}

/** Red/yellow patients nobody has taken for `afterS` seconds -> nudge the commander, once per patient. */
export function findNudges(s: IncidentState, now: number, afterS: number, commander: string): CoachTrigger[] {
  return s.patients
    .filter((p) => (p.triage === 'red' || p.triage === 'yellow') && !p.assigned_to && p.status === 'located' && now - p.first_ts >= afterS)
    .map((p) => ({ kind: 'nudge' as const, key: `nudge:${p.id}`, to: commander, patient: p, waited_s: Math.round(now - p.first_ts) }))
}

/** The deterministic nudge text (no model: it must never be wrong about who is waiting). */
export function nudgeText(t: Extract<CoachTrigger, { kind: 'nudge' }>): { message: string; steps: string[] } {
  const p = t.patient
  return {
    message: `${p.id}, ${p.age_group}, ${String(p.triage).toUpperCase()}, has had no one assigned for ${t.waited_s} seconds. Assign a unit.`,
    steps: [`Assign a crew to ${p.id}` + (p.floor !== null ? ` on floor ${p.floor}` : ''), 'Confirm on the radio who has the patient'],
  }
}
