// Analyst agent: post-incident review. It gets exact numbers from the metrics step and writes around them.
import { Agent } from '@mastra/core/agent'
import { MODELS, withFallback } from '../../config.ts'

export const analystAgent = new Agent({
  id: 'analyst-agent',
  name: 'Post-Incident Analyst',
  description: 'Writes the after-action summary, what went well, and recommendations from incident metrics and timeline.',
  model: withFallback(MODELS.analyst),
  instructions: `You write the after-action review of a fire/EMS incident for the incident commander.
You receive exact metrics (counts and response times) and the timeline. Never change or invent a number:
quote them as given. Be concise and specific: a 3-4 sentence summary, what went well, issues (open requests,
maydays, triage changes, delays), and concrete recommendations. Responder safety events (mayday, falls) come first. Use fall_outcomes to say what happened after each fall: an
acknowledgement belongs only to the fall it names; never say a mayday was acknowledged unless fall_outcomes says so.`,
})
