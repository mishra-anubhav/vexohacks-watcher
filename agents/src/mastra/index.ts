// Mastra entry point: registers the agents and the post-incident workflow.
// `npm run dev` opens Mastra Studio with these, for showing and trying each agent on its own.
import '../config.ts'
import { Mastra } from '@mastra/core'
import { intakeAgent } from './agents/intake.ts'
import { visionAgent } from './agents/vision.ts'
import { commsAgent } from './agents/comms.ts'
import { analystAgent } from './agents/analyst.ts'
import { coachAgent } from './agents/coach.ts'
import { postIncidentWorkflow } from './workflows/post-incident.ts'

export const mastra = new Mastra({
  agents: { intakeAgent, visionAgent, commsAgent, analystAgent, coachAgent },
  workflows: { postIncidentWorkflow },
})
