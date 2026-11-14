// Post-incident numbers, computed from the final state and the event log. No LLM here:
// counts and times in a report must be exact, so the analyst agent only writes prose
// around these numbers.
import type { IncidentState } from './state.ts'

export type BusEvent = { type: string; ts: number; responder?: string; fell_at?: number; during?: string; text?: string; [k: string]: unknown }

export type Metrics = {
  started: number | null; ended: number; duration_s: number
  patients_total: number
  triage_counts: Record<'red' | 'yellow' | 'green' | 'black' | 'untriaged', number>
  initial_triage_counts: Record<'red' | 'yellow' | 'green' | 'black' | 'untriaged', number>
  triage_changes: { patient: string; from: string | null; to: string; at_s: number; by: string }[]
  hazards: { id: string; description: string }[]
  open_requests: { id: string; description: string; open_for_s: number }[]
  fulfilled_requests: number
  actions: { id: string; description: string; status: string }[]
  falls: number; maydays: number; acks: number
  fall_outcomes: { responder: string; fall_at_s: number; outcome: string }[]
  response_times: { label: string; seconds: number }[]
  coaching: { to: string; trigger: string; at_s: number; message: string }[]
}

const zero = () => ({ red: 0, yellow: 0, green: 0, black: 0, untriaged: 0 })
const round = (n: number) => Math.round(n * 10) / 10

export function computeMetrics(state: IncidentState, events: BusEvent[], ended = Date.now() / 1000): Metrics {
  const started = state.started ?? (events.length ? events[0].ts : ended)
  const rel = (ts: number) => round(ts - started)
  const triage_counts = zero()
  const initial_triage_counts = zero()
  const triage_changes: Metrics['triage_changes'] = []
  const response_times: Metrics['response_times'] = []

  for (const p of state.patients) {
    triage_counts[(p.triage ?? 'untriaged') as keyof typeof triage_counts]++
    const first = p.triage_history[0]?.to ?? 'untriaged'
    initial_triage_counts[first as keyof typeof initial_triage_counts]++
    for (const h of p.triage_history.slice(1)) triage_changes.push({ patient: p.id, from: h.from, to: h.to, at_s: rel(h.ts), by: h.by })
    const updates = state.timeline.filter((t) => t.text.startsWith(`${p.id} updated:`))
    const assigned = updates.find((t) => t.text.includes('assigned'))
    if (assigned) response_times.push({ label: `${p.id} reported → care assigned (${p.assigned_to})`, seconds: round(assigned.ts - p.first_ts) })
    const transporting = updates.find((t) => t.text.includes('transporting'))
    if (transporting) response_times.push({ label: `${p.id} reported → transporting`, seconds: round(transporting.ts - p.first_ts) })
  }

  const falls = events.filter((e) => e.type === 'fall')
  const maydays = events.filter((e) => e.type === 'mayday')
  const acks = events.filter((e) => e.type === 'ack')
  for (const m of maydays) if (m.fell_at) response_times.push({ label: `${m.responder ?? 'responder'} fall → mayday`, seconds: round(m.ts - m.fell_at) })
  for (const a of acks) if (a.fell_at) response_times.push({ label: `${a.responder ?? 'responder'} fall → acknowledged`, seconds: round(a.ts - a.fell_at) })

  // What happened after each fall: the mayday and the ack each name the fall they belong to.
  const fall_outcomes = falls.map((f) => {
    const at = (f.at as number | undefined) ?? f.ts
    const m = maydays.find((x) => x.fell_at === at)
    const a = acks.find((x) => x.fell_at === at)
    const c = events.find((x) => x.type === 'cancel' && x.ts >= at && (!m || x.ts < m.ts))
    const outcome = a && !m ? `acknowledged by double-tap after ${round(a.ts - at)}s — no mayday`
      : m && a ? `MAYDAY after ${round(m.ts - at)}s, responder acknowledged after ${round(a.ts - at)}s`
      : m ? `MAYDAY after ${round(m.ts - at)}s — never acknowledged by the responder`
      : c ? 'responder moved — alarm cancelled' : 'no outcome recorded'
    return { responder: f.responder ?? 'responder', fall_at_s: rel(at), outcome }
  })

  for (const r of state.requests) {
    if (r.status === 'fulfilled' && r.closed_ts) response_times.push({ label: `${r.id} ${r.description} → fulfilled`, seconds: round(r.closed_ts - r.ts) })
  }

  return {
    started, ended, duration_s: round(ended - started),
    patients_total: state.patients.length, triage_counts, initial_triage_counts, triage_changes,
    hazards: state.hazards.map((h) => ({ id: h.id, description: h.description })),
    open_requests: state.requests.filter((r) => r.category === 'resource' && r.status === 'open')
      .map((r) => ({ id: r.id, description: r.description, open_for_s: round(ended - r.ts) })),
    fulfilled_requests: state.requests.filter((r) => r.status === 'fulfilled').length,
    actions: state.requests.filter((r) => r.category === 'action').map((r) => ({ id: r.id, description: r.description, status: r.status })),
    falls: falls.length, maydays: maydays.length, acks: acks.length, fall_outcomes,
    response_times,
    coaching: (state.coaching ?? []).map((c) => ({ to: c.to, trigger: c.trigger, at_s: rel(c.ts), message: c.message })),
  }
}
