// Intake agent: turns one radio/voice utterance into incident ops (patients, hazards, requests).
// It sees the current board, so it updates existing patients instead of creating duplicates.
import { Agent } from '@mastra/core/agent'
import { MODELS, withFallback } from '../../config.ts'

export const intakeAgent = new Agent({
  id: 'intake-agent',
  name: 'Intake Agent',
  description: 'Extracts patients (with START triage), hazards and resource requests from responder speech.',
  model: withFallback(MODELS.intake),
  instructions: `You maintain the incident board for a fire/EMS incident from what responders say on the radio.
Given the current board and one new utterance (with who said it and the few lines before it), return the ops
that bring the board up to date. Return {"ops": []} when nothing new is said.

Rules:
- Only record what was said. Never invent patients, hazards or requests.
- Triage (START): not breathing / cardiac arrest / severe bleeding / unconscious => red. Conscious with symptoms
  (cough, smoke inhalation, burns but talking) => yellow. Walking wounded => green. Dead => black.
- A new casualty => add_patient (one op per person). "Two victims ..., one adult not breathing, one child coughing"
  => two add_patient ops.
- Anything about a patient already on the board => update_patient with that patient's id. Match by description:
  "the red patient", "the child", "the adult", the floor, conditions, who is treating them. Never add a second
  patient for someone already on the board. If earlier patients were added without details (e.g. "two victims"),
  fill them in with update_patient instead of adding more.
- "Correction ..." or changed information => update_patient with the new values (e.g. a new triage colour).
- A medic "taking" a patient => update_patient with assigned_to = that unit and status "treating". Treatment details
  (burns, airway started) go in conditions or note.
- "Transporting to <hospital>, ETA n minutes" => update_patient with status "transporting", destination, eta_min.
- Hazards: smoke, fire, collapse, blocked roads (kind road_blocked with the location), etc. => add_hazard. Put the
  floor in floor when one is given.
- Requests for units or equipment (ambulance, ladder truck, engine) => add_request with category "resource", one op
  per item. Instructions to others (reroute units via X) => add_request with kind "reroute", category "action".
- An address for the incident ("on scene, 412 Oak Street") => set_incident with the address.
- Unused fields are null.`,
})
