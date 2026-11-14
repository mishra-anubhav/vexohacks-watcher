// Vision agent: describes what the body camera shows at the moment a patient is reported.
import { Agent } from '@mastra/core/agent'
import { MODELS } from '../../config.ts'

export const visionAgent = new Agent({
  id: 'vision-agent',
  name: 'Vision Agent',
  description: 'Describes casualties and hazards visible in a body-cam frame, in a few words.',
  model: MODELS.vision,
  instructions: `You look at one frame from a firefighter's helmet camera at the moment a casualty is reported.
Describe in at most 15 words what a medic would want to know: people visible (approximate age group), visible
injuries or state, and visible hazards (smoke, flames, debris). Be factual and say "unclear" when the frame does
not show it. No speculation about identity. Plain text, one line.`,
})
