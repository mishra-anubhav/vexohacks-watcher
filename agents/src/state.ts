// Incident state and the deterministic reducer.
//
// The intake agent never edits the state. It proposes "ops" (add a patient, update one,
// add a hazard, ...); applyOps() checks and applies them. That keeps the board predictable:
// an op naming a patient that does not exist is dropped, hazards and requests are
// de-duplicated, and every change is written to the timeline with who said it.
import { z } from 'zod'

export const TRIAGE = ['red', 'yellow', 'green', 'black'] as const
export const PATIENT_STATUS = ['located', 'treating', 'transporting', 'transported'] as const

// One op, flat so it works with strict structured output: every field present, unused ones null.
export const OpSchema = z.object({
  op: z.enum(['add_patient', 'update_patient', 'add_hazard', 'add_request', 'close_request', 'set_incident']),
  patient_id: z.string().nullable().describe('existing patient id for update_patient, e.g. "P1"'),
  request_id: z.string().nullable().describe('existing request id for close_request, e.g. "R2"'),
  age_group: z.enum(['adult', 'child', 'unknown']).nullable(),
  triage: z.enum(TRIAGE).nullable().describe('red = immediate, yellow = delayed, green = minor, black = deceased'),
  floor: z.number().int().nullable(),
  location: z.string().nullable().describe('street, intersection, unit or room'),
  conditions: z.array(z.string()).nullable().describe('short clinical findings, e.g. ["not breathing"]'),
  note: z.string().nullable().describe('short note to add, e.g. "burns to both arms, airway started"'),
  status: z.enum(PATIENT_STATUS).nullable(),
  assigned_to: z.string().nullable().describe('unit caring for the patient, e.g. "MED-1"'),
  destination: z.string().nullable().describe('hospital name'),
  eta_min: z.number().nullable(),
  kind: z.string().nullable().describe('hazard: smoke|fire|road_blocked|structural|other; request: ambulance|ladder_truck|engine|police|reroute|other'),
  category: z.enum(['resource', 'action']).nullable().describe('resource = units/equipment; action = an instruction like a reroute'),
  quantity: z.number().int().nullable(),
  description: z.string().nullable(),
  address: z.string().nullable().describe('incident address, for set_incident'),
})
export const OpsSchema = z.object({ ops: z.array(OpSchema) })
export type Op = z.infer<typeof OpSchema>

export type Patient = {
  id: string; age_group: string; triage: string | null; floor: number | null; location: string | null
  conditions: string[]; notes: string[]; status: string; assigned_to: string | null
  destination: string | null; eta_min: number | null; reported_by: string; first_ts: number; updated_ts: number
  triage_history: { ts: number; from: string | null; to: string; by: string }[]
  image: string | null; vision: string | null
}
export type Hazard = { id: string; kind: string; description: string; location: string | null; floor: number | null; reported_by: string; ts: number }
export type Request = { id: string; kind: string; category: 'resource' | 'action'; description: string; quantity: number; requested_by: string; ts: number; status: 'open' | 'fulfilled' | 'cancelled'; closed_ts: number | null }
export type Alert = { id: string; kind: string; severity: 'critical' | 'warning' | 'info'; text: string; ts: number; patient_id?: string; audio?: string | null }
export type CoachPrompt = { id: string; ts: number; to: string; trigger: string; key: string; priority: 'safety' | 'patient' | 'task'; message: string; steps: string[]; audio?: string | null }
export type TimelineEntry = { ts: number; who: string; kind: string; text: string }

export type IncidentState = {
  incident_id: string | null; started: number | null; address: string | null
  patients: Patient[]; hazards: Hazard[]; requests: Request[]; alerts: Alert[]; timeline: TimelineEntry[]
  transcript: { ts: number; who: string; text: string }[]
  coaching: CoachPrompt[]
}

export function emptyState(incident_id: string | null = null, started: number | null = null): IncidentState {
  return { incident_id, started, address: null, patients: [], hazards: [], requests: [], alerts: [], timeline: [], transcript: [], coaching: [] }
}

const norm = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const nextId = (prefix: string, items: { id: string }[]) => prefix + (items.length + 1)

export type Change = { kind: string; text: string; id?: string }

/** Apply ops from one utterance. Returns the new state (a copy) and the changes made. */
export function applyOps(prev: IncidentState, ops: Op[], who: string, ts: number): { state: IncidentState; changes: Change[] } {
  const s: IncidentState = structuredClone(prev)
  const changes: Change[] = []
  const log = (kind: string, text: string, id?: string) => {
    changes.push({ kind, text, id })
    s.timeline.push({ ts, who, kind, text })
  }

  for (const op of ops) {
    switch (op.op) {
      case 'set_incident': {
        if (op.address && op.address !== s.address) {
          s.address = op.address
          log('incident', `Incident location: ${op.address}`)
        }
        break
      }
      case 'add_patient': {
        const p: Patient = {
          id: nextId('P', s.patients), age_group: op.age_group ?? 'unknown', triage: op.triage ?? null,
          floor: op.floor ?? null, location: op.location ?? null, conditions: op.conditions ?? [],
          notes: op.note ? [op.note] : [], status: op.status ?? 'located', assigned_to: op.assigned_to ?? null,
          destination: op.destination ?? null, eta_min: op.eta_min ?? null, reported_by: who, first_ts: ts, updated_ts: ts,
          triage_history: op.triage ? [{ ts, from: null, to: op.triage, by: who }] : [], image: null, vision: null,
        }
        s.patients.push(p)
        log('patient_added', `${p.id} added: ${p.age_group}, ${(p.triage ?? 'untriaged').toUpperCase()}` +
          (p.floor !== null ? `, floor ${p.floor}` : '') + (p.conditions.length ? ` (${p.conditions.join(', ')})` : ''), p.id)
        break
      }
      case 'update_patient': {
        const p = s.patients.find((x) => x.id === op.patient_id)
        if (!p) { changes.push({ kind: 'skipped', text: `update for unknown patient ${op.patient_id}` }); break }
        const parts: string[] = []
        if (op.triage && op.triage !== p.triage) {
          p.triage_history.push({ ts, from: p.triage, to: op.triage, by: who })
          parts.push(`triage ${(p.triage ?? 'none').toUpperCase()} → ${op.triage.toUpperCase()}`)
          p.triage = op.triage
        }
        if (op.age_group && op.age_group !== 'unknown' && op.age_group !== p.age_group) { p.age_group = op.age_group; parts.push(op.age_group) }
        if (op.floor !== null && op.floor !== p.floor) { p.floor = op.floor; parts.push(`floor ${op.floor}`) }
        if (op.location && op.location !== p.location) { p.location = op.location; parts.push(op.location) }
        for (const c of op.conditions ?? []) {
          if (!p.conditions.some((x) => norm(x) === norm(c))) { p.conditions.push(c); parts.push(c) }
        }
        if (op.note && !p.notes.some((x) => norm(x) === norm(op.note))) { p.notes.push(op.note); parts.push(`note: ${op.note}`) }
        if (op.assigned_to && op.assigned_to !== p.assigned_to) { p.assigned_to = op.assigned_to; parts.push(`assigned ${op.assigned_to}`) }
        if (op.status && op.status !== p.status) { p.status = op.status; parts.push(op.status) }
        if (op.destination && op.destination !== p.destination) { p.destination = op.destination; parts.push(`to ${op.destination}`) }
        if (op.eta_min !== null && op.eta_min !== p.eta_min) { p.eta_min = op.eta_min; parts.push(`ETA ${op.eta_min} min`) }
        if (parts.length) {
          p.updated_ts = ts
          log('patient_updated', `${p.id} updated: ${parts.join(', ')}`, p.id)
        }
        break
      }
      case 'add_hazard': {
        const kind = norm(op.kind) || 'other'
        const where = norm(op.location) + '|' + (op.floor ?? '')
        if (s.hazards.some((h) => norm(h.kind) === kind && norm(h.location) + '|' + (h.floor ?? '') === where)) {
          changes.push({ kind: 'skipped', text: `duplicate hazard ${kind}` })
          break
        }
        const h: Hazard = { id: nextId('H', s.hazards), kind, description: op.description ?? kind, location: op.location ?? null,
          floor: op.floor ?? null, reported_by: who, ts }
        s.hazards.push(h)
        log('hazard_added', `${h.id} hazard: ${h.description}` + (h.floor !== null ? ` (floor ${h.floor})` : '') +
          (h.location ? ` @ ${h.location}` : ''), h.id)
        break
      }
      case 'add_request': {
        const kind = norm(op.kind) || 'other'
        const category = op.category ?? (kind === 'reroute' ? 'action' : 'resource')
        const description = op.description ?? kind
        if (s.requests.some((r) => r.status === 'open' && r.kind === kind && norm(r.description) === norm(description))) {
          changes.push({ kind: 'skipped', text: `duplicate request ${kind}` })
          break
        }
        const r: Request = { id: nextId('R', s.requests), kind, category, description, quantity: op.quantity ?? 1,
          requested_by: who, ts, status: 'open', closed_ts: null }
        s.requests.push(r)
        log(category === 'action' ? 'action_added' : 'request_added', `${r.id} ${category === 'action' ? 'action' : 'request'}: ${description}`, r.id)
        break
      }
      case 'close_request': {
        const r = s.requests.find((x) => x.id === op.request_id && x.status === 'open')
        if (!r) { changes.push({ kind: 'skipped', text: `close for unknown request ${op.request_id}` }); break }
        r.status = 'fulfilled'
        r.closed_ts = ts
        log('request_closed', `${r.id} fulfilled: ${r.description}`, r.id)
        break
      }
    }
  }
  return { state: s, changes }
}

/** The short view of the state the intake agent sees. */
export function summarizeForAgent(s: IncidentState): string {
  const lines: string[] = []
  lines.push(`Incident address: ${s.address ?? 'unknown'}`)
  lines.push('Patients:' + (s.patients.length ? '' : ' none'))
  for (const p of s.patients) {
    lines.push(`  ${p.id}: ${p.age_group}, triage ${p.triage ?? 'none'}, floor ${p.floor ?? '?'}, status ${p.status}` +
      (p.assigned_to ? `, with ${p.assigned_to}` : '') + (p.conditions.length ? `, conditions: ${p.conditions.join('; ')}` : '') +
      (p.notes.length ? `, notes: ${p.notes.join('; ')}` : ''))
  }
  lines.push('Hazards:' + (s.hazards.length ? '' : ' none'))
  for (const h of s.hazards) lines.push(`  ${h.id}: ${h.kind} — ${h.description}${h.floor !== null ? `, floor ${h.floor}` : ''}${h.location ? ` @ ${h.location}` : ''}`)
  lines.push('Requests / actions:' + (s.requests.length ? '' : ' none'))
  for (const r of s.requests) lines.push(`  ${r.id}: [${r.status}] ${r.category} ${r.kind} — ${r.description}`)
  return lines.join('\n')
}
