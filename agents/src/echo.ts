// Echo guard: the laptop speaks alerts and coaching; the band's microphone hears them and
// Deepgram writes them down as if a responder said them. stripEcho() removes from a band
// transcript every run of 4+ words that the system itself spoke around that time. (3 was too
// short: "on floor 3" from the coach stripped the floor from a captain's real line.)
// "third" and "3rd", "one" and "1": the speaker says one, Deepgram may write the other
const SAME: Record<string, string> = { one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
  first: '1st', second: '2nd', third: '3rd', fourth: '4th', fifth: '5th' }
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean).map((w) => SAME[w] ?? w)
const N = 4

export function stripEcho(transcript: string, spoken: string[]): { text: string; removed: number } {
  const said = new Set<string>()
  for (const s of spoken) {
    const w = words(s)
    for (let i = 0; i + N <= w.length; i++) said.add(w.slice(i, i + N).join(' '))
  }
  const raw = transcript.split(/\s+/).filter(Boolean)
  const w = raw.map((x) => words(x).join(' '))
  const echo = new Array(raw.length).fill(false)
  for (let i = 0; i + N <= w.length; i++) {
    if (said.has(w.slice(i, i + N).join(' '))) for (let k = i; k < i + N; k++) echo[k] = true
  }
  const kept = raw.filter((_, i) => !echo[i])
  // drop stray punctuation-only leftovers like "." or ","
  const text = kept.join(' ').replace(/^[\s.,;:!?-]+/, '').replace(/\s+([.,;:!?])/g, '$1').trim()
  return { text: words(text).length ? text : '', removed: echo.filter(Boolean).length }
}
