// T13: echo guard, with the real transcript from the first live band run.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stripEcho } from '../src/echo.ts'

const coachSaid = 'All crews. Stay low, use SCBA, and keep a clear exit from the third-floor smoke.'

test('T13.1 real echo: coach words removed, the captain\'s words kept', () => {
  const heard = 'Say calmly and clearly like a supportive mentor. All crews, stay low, use SCBA, and keep a clear exit from the 3rd Floor smoke. Two victims on Floor 3, one adult not breathing, one child conscious.'
  const r = stripEcho(heard, ['Say calmly and clearly, like a supportive mentor: ' + coachSaid])
  assert.match(r.text, /^Two victims on Floor 3, one adult not breathing, one child conscious\.$/)
})

test('T13.2 nothing spoken -> transcript unchanged', () => {
  const t = 'Requesting a second ambulance and a ladder truck.'
  assert.deepEqual(stripEcho(t, []), { text: t, removed: 0 })
})

test('T13.3 pure echo -> empty (dropped)', () => {
  assert.equal(stripEcho('All crews, stay low, use SCBA and keep a clear exit.', [coachSaid]).text, '')
})

test('T13.5 a common 3-word phrase the coach used is NOT stripped from a real line', () => {
  const r = stripEcho('Two victims on Floor 3, one adult not breathing, one child conscious with a cough.',
    ['All crews. Heavy smoke on floor three. Stay low, check your air supply, and confirm with command.'])
  assert.match(r.text, /^Two victims on Floor 3,/)
})

test('T13.4 a responder repeating two words is not removed (needs 3 in a row)', () => {
  const r = stripEcho('Stay low, moving to floor 3.', [coachSaid])
  assert.equal(r.text, 'Stay low, moving to floor 3.')
})
