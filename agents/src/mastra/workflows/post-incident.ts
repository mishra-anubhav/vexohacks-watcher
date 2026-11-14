// Post-incident workflow: exact metrics first (code), then the analyst agent writes the review,
// then the report is assembled. Three steps, so each is visible and re-runnable in Mastra Studio.
import { createStep, createWorkflow } from '@mastra/core/workflows'
import { z } from 'zod'
import { computeMetrics, type Metrics } from '../../metrics.ts'
import type { IncidentState } from '../../state.ts'
import { analystAgent } from '../agents/analyst.ts'

const Input = z.object({ state: z.any(), events: z.array(z.any()), ended: z.number() })
const Analysis = z.object({
  summary: z.string(),
  went_well: z.array(z.string()),
  issues: z.array(z.string()),
  recommendations: z.array(z.string()),
})

const metricsStep = createStep({
  id: 'compute-metrics',
  description: 'Counts, open requests, safety events and response times, computed exactly from the log.',
  inputSchema: Input,
  outputSchema: z.object({ state: z.any(), metrics: z.any() }),
  execute: async ({ inputData }) => ({
    state: inputData.state,
    metrics: computeMetrics(inputData.state as IncidentState, inputData.events, inputData.ended),
  }),
})

const analyzeStep = createStep({
  id: 'analyze',
  description: 'The analyst agent writes summary, what went well, issues and recommendations.',
  inputSchema: z.object({ state: z.any(), metrics: z.any() }),
  outputSchema: z.object({ state: z.any(), metrics: z.any(), analysis: Analysis }),
  execute: async ({ inputData }) => {
    const s = inputData.state as IncidentState
    const prompt = `Incident at ${s.address ?? 'unknown address'}.

METRICS (exact, quote as given):
${JSON.stringify(inputData.metrics, null, 2)}

TIMELINE (seconds from start):
${s.timeline.map((t) => `+${Math.round(t.ts - (s.started ?? t.ts))}s ${t.who}: ${t.text}`).join('\n')}`
    const r = await analystAgent.generate(prompt, { structuredOutput: { schema: Analysis } })
    return { ...inputData, analysis: r.object as z.infer<typeof Analysis> }
  },
})

const fmt = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${s}s`)

const assembleStep = createStep({
  id: 'assemble-report',
  description: 'Builds the report document (markdown) from metrics, timeline and analysis.',
  inputSchema: z.object({ state: z.any(), metrics: z.any(), analysis: Analysis }),
  outputSchema: z.object({ metrics: z.any(), analysis: Analysis, markdown: z.string() }),
  execute: async ({ inputData }) => {
    const s = inputData.state as IncidentState
    const m = inputData.metrics as Metrics
    const a = inputData.analysis
    const tc = m.triage_counts
    const md = [
      `# After-action report — ${s.address ?? 'incident'}`,
      `Incident ${s.incident_id ?? ''} · duration ${fmt(m.duration_s)}`,
      '', '## Summary', a.summary,
      '', '## Key numbers',
      `- Patients: ${m.patients_total} (red ${tc.red}, yellow ${tc.yellow}, green ${tc.green}, black ${tc.black}, untriaged ${tc.untriaged})`,
      `- Responder safety: ${m.falls} falls, ${m.maydays} mayday, ${m.acks} acknowledged`,
      ...m.fall_outcomes.map((f) => `  - ${f.responder} fall at +${fmt(f.fall_at_s)}: ${f.outcome}`),
      `- Open resource requests: ${m.open_requests.length}${m.open_requests.length ? ' — ' + m.open_requests.map((r) => `${r.description} (open ${fmt(r.open_for_s)})`).join(', ') : ''}`,
      `- Action items: ${m.actions.map((x) => `${x.description} [${x.status}]`).join(', ') || 'none'}`,
      `- Hazards: ${m.hazards.map((h) => h.description).join(', ') || 'none'}`,
      ...(m.triage_changes.length ? [`- Triage changes: ${m.triage_changes.map((c) => `${c.patient} ${c.from} → ${c.to} at +${c.at_s}s`).join(', ')}`] : []),
      '', '## Response times', ...m.response_times.map((r) => `- ${r.label}: ${fmt(r.seconds)}`),
      '', '## Coaching given (advisory)', ...(m.coaching.length ? m.coaching.map((c) => `- +${fmt(c.at_s)} → ${c.to} (${c.trigger}): ${c.message}`) : ['- none']),
      '', '## Timeline', ...s.timeline.map((t) => `- +${fmt(Math.round(t.ts - (s.started ?? t.ts)))} **${t.who}** ${t.text}`),
      '', '## What went well', ...a.went_well.map((x) => `- ${x}`),
      '', '## Issues', ...a.issues.map((x) => `- ${x}`),
      '', '## Recommendations', ...a.recommendations.map((x) => `- ${x}`),
    ].join('\n')
    return { metrics: m, analysis: a, markdown: md }
  },
})

export const postIncidentWorkflow = createWorkflow({
  id: 'post-incident',
  description: 'After-action report: exact metrics, analyst review, assembled report.',
  inputSchema: Input,
  outputSchema: z.object({ metrics: z.any(), analysis: Analysis, markdown: z.string() }),
})
  .then(metricsStep)
  .then(analyzeStep)
  .then(assembleStep)
  .commit()
