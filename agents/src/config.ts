// Every setting in one place: models, addresses, scenario defaults.
// Keys are read from ../.env (never from code) and mapped to the names Mastra expects.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const AGENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
export const ROOT = join(AGENTS_DIR, '..')

function loadEnv(file: string) {
  try {
    for (const raw of readFileSync(file, 'utf8').split('\n')) {
      const line = raw.trim().replace(/^export\s+/, '')
      const i = line.indexOf('=')
      if (i < 1 || line.startsWith('#')) continue
      const name = line.slice(0, i).trim()
      const value = line.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')
      if (value && !process.env[name]) process.env[name] = value
    }
  } catch {
    // no .env: keys may come from the environment
  }
}
loadEnv(join(ROOT, '.env'))
if (process.env.GEMINI_API_KEY) {
  process.env.GOOGLE_API_KEY ??= process.env.GEMINI_API_KEY
  process.env.GOOGLE_GENERATIVE_AI_API_KEY ??= process.env.GEMINI_API_KEY
}

export const MODELS = {
  // Gemini Flash-Lite: measured 1.0–1.5 s per line vs 2.0–2.4 s for gpt-6-luna, same results on all live tests
  intake: process.env.INTAKE_MODEL ?? 'google/gemini-3.1-flash-lite',  // transcript -> incident ops (fast, structured)
  vision: process.env.VISION_MODEL ?? 'google/gemini-3.8-flash', // body-cam frame -> casualty description
  // MiniMax runs the two writing agents when its key is set; OpenAI otherwise
  comms: process.env.COMMS_MODEL ?? (process.env.MINIMAX_API_KEY ? 'minimax/MiniMax-M3.1-Flash' : 'openai/gpt-6-luna'),   // hospital pre-alert wording
  analyst: process.env.ANALYST_MODEL ?? (process.env.MINIMAX_API_KEY ? 'minimax/MiniMax-M3' : 'openai/gpt-6-luna'),      // post-incident analysis
  coach: process.env.COACH_MODEL ?? 'google/gemini-3.1-flash-lite',    // next-step guidance for junior responders
}

// low reasoning effort: intake measured ~2.1 s instead of ~3.9 s, same ops on the script lines
export const FAST = { providerOptions: { openai: { reasoningEffort: 'low' } } } as const

/** MiniMax first when its key is set, OpenAI if MiniMax fails (no balance, outage). Mastra tries them in order. */
export function withFallback(primary: string, fallback = 'openai/gpt-6-luna'): any {
  return primary === fallback ? primary : [{ model: primary, maxRetries: 0 }, { model: fallback, maxRetries: 1 }]
}

export const SPEECH = {
  minimaxModel: process.env.MINIMAX_TTS_MODEL ?? 'speech-2.8-turbo',
  minimaxVoice: process.env.MINIMAX_VOICE_ID ?? 'English_Persuasive_Man',
  minimaxCoachVoice: process.env.MINIMAX_COACH_VOICE_ID ?? 'English_Graceful_Lady',
  elevenVoice: process.env.ELEVENLABS_VOICE_ID ?? 'JBFqnCBsd6RMkjVDRZzb',
  elevenModel: 'eleven_flash_v2_5',
  geminiModel: 'gemini-3.8-flash-tts',
  geminiVoice: 'Kore',
  playLocally: process.env.SPEAK_LOCALLY !== '0',             // play alerts on the laptop speakers (afplay)
}

export const PORT = Number(process.env.AGENTS_PORT ?? 4111)
export const BUS = process.env.BUS_URL ?? 'http://127.0.0.1:8090'
export const AUDIO_DIR = join(AGENTS_DIR, 'audio')
export const FRAMES_DIR = join(AGENTS_DIR, 'frames')
export const INCIDENTS_DIR = join(ROOT, 'incidents')

export const COACH = {
  nudgeAfterS: Number(process.env.COACH_NUDGE_S ?? 60),   // red/yellow patient with nobody assigned this long -> nudge command
  commander: process.env.INCIDENT_COMMANDER ?? 'FIRE-CPT-1',
  speak: process.env.COACH_SPEAK !== '0',
}
