import test from 'node:test'
import assert from 'node:assert/strict'
import { encodeWav, VoiceActivity, SpeechSentences } from '../src/voiceAudio.js'

test('WAV preserves samples, duration and clipping', () => {
  const bytes = encodeWav([new Float32Array([-2, 0, 2])], 16000), view = new DataView(bytes.buffer)
  assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), 'RIFF')
  assert.equal(view.getUint32(24, true), 16000)
  assert.equal(view.getUint32(40, true), 6)
  assert.deepEqual([44, 46, 48].map(offset => view.getInt16(offset, true)), [-32768, 0, 32767])
})
test('voice activity ignores silence and short clicks, sends after speech pause, bounds recording', () => {
  const detector = new VoiceActivity(1000, { silenceMs: 400, maxSeconds: 1 })
  const quiet = new Float32Array(100), speech = new Float32Array(100).fill(.1)
  for (let i = 0; i < 20; i++) assert.equal(detector.push(quiet), null)
  detector.push(speech); for (let i = 0; i < 4; i++) assert.equal(detector.push(quiet), null)
  for (let i = 0; i < 4; i++) detector.push(speech)
  for (let i = 0; i < 3; i++) assert.equal(detector.push(quiet), null)
  assert.ok(detector.push(quiet)?.length)
  for (let i = 0; i < 9; i++) assert.equal(detector.push(speech), null)
  assert.ok(detector.push(speech)?.length)
})
test('sentences arrive before completion and code blocks are never spoken', () => {
  const queue = new SpeechSentences()
  assert.deepEqual(queue.push('你好'), [])
  assert.deepEqual(queue.push('。这是 **语音**。\n```js\nconsole.log("secret");\n'), ['你好。', '这是 语音。'])
  assert.deepEqual(queue.push('```\n下一句'), [])
  assert.deepEqual(queue.push('', true), ['下一句'])
})
