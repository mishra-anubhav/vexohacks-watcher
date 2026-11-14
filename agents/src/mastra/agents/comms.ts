// Comms agent: writes the hospital pre-alert spoken to the receiving ER.
import { Agent } from '@mastra/core/agent'
import { MODELS, withFallback } from '../../config.ts'

export const commsAgent = new Agent({
  id: 'comms-agent',
  name: 'Comms Agent',
  description: 'Writes short, standard hospital pre-alerts (ATMIST style) for patients being transported.',
  model: withFallback(MODELS.comms),
  instructions: `You write the pre-alert a dispatcher reads to a receiving emergency department.
Use the ATMIST order, compressed into at most 40 words, spoken style, no lists or abbreviations a text-to-speech
voice would stumble on: who is coming (age group), mechanism (house fire, smoke), injuries and findings,
treatment so far, triage priority, ETA. Start with the hospital name. Use only the facts given.`,
})
