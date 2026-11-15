// Text to speech for alerts. MiniMax first, then ElevenLabs, then Gemini TTS: a provider with
// no key, missing permission or no credits is skipped for the rest of the run, so an alert is
// never silent. Clips are cached by text and played one at a time.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { AUDIO_DIR, SPEECH } from './config.ts'

mkdirSync(AUDIO_DIR, { recursive: true })
let elevenDisabled: string | null = process.env.ELEVENLABS_API_KEY ? null : 'no ELEVENLABS_API_KEY'
let minimaxDisabled: string | null = process.env.MINIMAX_API_KEY ? null : 'no MINIMAX_API_KEY'

export type Spoken = { file: string; name: string; provider: 'minimax' | 'elevenlabs' | 'gemini' }
export type Tone = 'urgent' | 'calm' | 'coach'

async function minimax(text: string, tone: Tone): Promise<Buffer> {
  const r = await fetch('https://api.minimax.io/v1/t2a_v2', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.MINIMAX_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: SPEECH.minimaxModel, text, stream: false, output_format: 'hex',
      voice_setting: { voice_id: tone === 'coach' ? SPEECH.minimaxCoachVoice : SPEECH.minimaxVoice,
        speed: tone === 'urgent' ? 1.1 : 1, vol: 1, pitch: 0, ...(tone === 'urgent' ? {} : { emotion: 'calm' }) },
      audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
    }),
  })
  const j = (await r.json().catch(() => ({}))) as any
  const code = j?.base_resp?.status_code
  if (!r.ok || code !== 0 || !j?.data?.audio) {
    if (r.status === 401 || code === 1004 || code === 1008) minimaxDisabled = `MiniMax ${r.status} code ${code}`   // auth / balance
    throw new Error(`MiniMax ${r.status} code ${code ?? '?'}`)
  }
  return Buffer.from(j.data.audio, 'hex')
}

async function eleven(text: string): Promise<Buffer> {
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${SPEECH.elevenVoice}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY!, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: SPEECH.elevenModel }),
  })
  if (!r.ok) {
    const body = await r.text().catch(() => '')
    const status = /"status":"([a-z_]+)"/.exec(body)?.[1] ?? ''
    if (r.status === 401 || r.status === 403 || status === 'quota_exceeded') elevenDisabled = `ElevenLabs ${r.status} ${status}`
    throw new Error(`ElevenLabs ${r.status} ${status}`)
  }
  return Buffer.from(await r.arrayBuffer())
}

function wav(pcm: Buffer, rate = 24000): Buffer {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12)
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24)
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([h, pcm])
}

async function gemini(text: string, _style: string): Promise<Buffer> {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${SPEECH.geminiModel}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY ?? '', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text }] }],   // only the words: a style prefix was sometimes read aloud
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: SPEECH.geminiVoice } } } },
    }),
  })
  if (!r.ok) throw new Error(`Gemini TTS ${r.status}`)
  const j = (await r.json()) as any
  const part = j?.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData)?.inlineData
  if (!part) throw new Error('Gemini TTS returned no audio')
  const data = Buffer.from(part.data, 'base64')
  return data.subarray(0, 4).toString() === 'RIFF' ? data : wav(data)
}

/** Make (or reuse) the audio for `text`. style is a delivery hint for Gemini ("Say urgently"). */
export async function synthesize(text: string, style = 'Say clearly and calmly', tone: Tone = 'calm'): Promise<Spoken> {
  const key = createHash('sha1').update(text + '|' + style + '|' + tone).digest('hex').slice(0, 16)
  for (const [provider, ext] of [['minimax', 'mp3'], ['elevenlabs', 'mp3'], ['gemini', 'wav']] as const) {
    const name = `${key}-${provider}.${ext}`
    if (existsSync(join(AUDIO_DIR, name))) return { file: join(AUDIO_DIR, name), name, provider }
  }
  if (!minimaxDisabled) {
    try {
      const name = `${key}-minimax.mp3`
      writeFileSync(join(AUDIO_DIR, name), await minimax(text, tone))
      return { file: join(AUDIO_DIR, name), name, provider: 'minimax' }
    } catch (e) {
      console.warn(`speech: ${String(e)} — trying the next voice`)
    }
  }
  if (!elevenDisabled) {
    try {
      const name = `${key}-elevenlabs.mp3`
      writeFileSync(join(AUDIO_DIR, name), await eleven(text))
      return { file: join(AUDIO_DIR, name), name, provider: 'elevenlabs' }
    } catch (e) {
      console.warn(`speech: ${String(e)} — using Gemini TTS`)
    }
  }
  const name = `${key}-gemini.wav`
  writeFileSync(join(AUDIO_DIR, name), await gemini(text, style))
  return { file: join(AUDIO_DIR, name), name, provider: 'gemini' }
}

export const speechStatus = () => ({ minimax: minimaxDisabled ? `off (${minimaxDisabled})` : 'on',
  elevenlabs: elevenDisabled ? `off (${elevenDisabled})` : 'on', fallback: 'gemini' })

// Laptop speakers: one clip at a time. An urgent clip (mayday) stops what is playing and
// jumps the queue, so a coaching tip can never delay a mayday.
const pending: { file: string; text: string }[] = []
let current: ReturnType<typeof spawn> | null = null
const played: { text: string; start: number; end: number | null }[] = []

/** What the speakers said between `from` and `to` (seconds), for the echo guard. */
export function spokenBetween(from: number, to: number): string[] {
  return played.filter((p) => p.start <= to && (p.end ?? Infinity) >= from).map((p) => p.text)
}

function next() {
  if (current || !pending.length) return
  const { file, text } = pending.shift()!
  const rec = { text, start: Date.now() / 1000, end: null as number | null }
  played.push(rec)
  if (played.length > 50) played.shift()
  current = spawn('afplay', [file], { stdio: 'ignore' })
  const done = () => { rec.end = Date.now() / 1000; current = null; next() }
  current.on('exit', done)
  current.on('error', done)
}

export function playLocally(file: string, urgent = false, text = ''): void {
  if (!SPEECH.playLocally) {
    // played by the operator's browser instead: estimate its length so the echo guard still knows
    const bytes = statSync(file).size
    const seconds = file.endsWith('.wav') ? bytes / 48000 : bytes * 8 / 128000
    const start = Date.now() / 1000
    played.push({ text, start, end: start + seconds + 1 })
    if (played.length > 50) played.shift()
    return
  }
  if (urgent) {
    pending.unshift({ file, text })
    current?.kill()
  } else {
    pending.push({ file, text })
  }
  next()
}
