import test from 'node:test'
import assert from 'node:assert/strict'
import { createTextReveal } from '../src/textReveal.js'

function fixture(options = {}) {
  let now = 0, nextId = 0
  const pending = new Map(), values = []
  const reveal = createTextReveal({ onText: value => values.push(value), request: callback => { pending.set(++nextId, callback); return nextId },
    cancel: id => pending.delete(id), reducedMotion: () => false, visible: () => true, ...options })
  const tick = () => { now += 16; const callbacks = [...pending.values()]; pending.clear(); callbacks.forEach(callback => callback(now)) }
  return { reveal, values, tick, pending }
}
test('live batches reveal Unicode characters before the next chunk or completion', () => {
  const f = fixture(); f.reveal.update('', { streaming: true })
  f.reveal.update('中🙂文', { streaming: true })
  f.tick(); assert.equal(f.reveal.text, '中')
  f.tick(); assert.equal(f.reveal.text, '中🙂')
  f.reveal.update('中🙂文继续', { streaming: true })
  f.tick(); assert.equal(f.reveal.text, '中🙂文')
  f.reveal.update('中🙂文继续', { streaming: false })
  assert.equal(f.reveal.text, '中🙂文继续'); assert.equal(f.pending.size, 0)
})
test('history and revised snapshots appear immediately instead of replaying old answers', () => {
  const f = fixture()
  f.reveal.update('历史内容', { streaming: true })
  assert.equal(f.reveal.text, '历史内容')
  f.reveal.update('历史内容新的部分', { streaming: true }); f.tick()
  f.reveal.update('修订后的内容', { streaming: true })
  assert.equal(f.reveal.text, '修订后的内容'); assert.equal(f.pending.size, 0)
  f.reveal.update('另一个会话', { streaming: true, reset: true })
  assert.equal(f.reveal.text, '另一个会话')
})
test('large batches catch up within the bounded display lag and close releases frames', () => {
  const f = fixture(); f.reveal.update('', { streaming: true })
  f.reveal.update('字'.repeat(10000), { streaming: true })
  for (let i = 0; i < 65; i++) f.tick()
  assert.equal(f.reveal.text.length, 10000); assert.equal(f.pending.size, 0)
  f.reveal.update('字'.repeat(10001), { streaming: true })
  f.reveal.close(); f.tick()
  assert.equal(f.pending.size, 0); assert.equal(f.reveal.text.length, 10000)
})
test('reduced motion and hidden views show received text without queued animation', () => {
  for (const options of [{ reducedMotion: () => true }, { visible: () => false }]) {
    const f = fixture(options); f.reveal.update('', { streaming: true })
    f.reveal.update('即时内容', { streaming: true })
    assert.equal(f.reveal.text, '即时内容'); assert.equal(f.pending.size, 0)
  }
})
