import test from 'node:test'
import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openChatStore } from '../chat-store.mjs'
import { streamChatEvents } from '../chat-http.mjs'

class SlowResponse extends Writable {
  constructor() { super({ highWaterMark: 32 }); this.frames = []; this.pending = [] }
  _write(chunk, encoding, done) { this.frames.push(chunk.toString()); this.pending.push(done) }
  writeHead() {}
  flushHeaders() {}
  release() { this.pending.shift()?.() }
}

async function fixture(t) {
  const stateDir = await mkdtemp(join(tmpdir(), 'openstarry-sse-test-'))
  const store = openChatStore({ stateDir })
  store.register({ adapterId: 'fixture', source: 'fixture' })
  const task = store.submit({ clientId: 'test', adapterId: 'fixture', sessionId: 'session', messageId: 'message', requestId: 'request', prompt: 'fixture only' })
  t.after(async () => { store.close(); await rm(stateDir, { recursive: true, force: true }) })
  return { store, task }
}

test('a stalled subscriber has a bounded buffer and is disconnected without losing durable events', async t => {
  const { store, task } = await fixture(t), res = new SlowResponse()
  streamChatEvents(store, {}, res, task.id, 0, { slowTimeoutMs: 50, heartbeatMs: 10 })
  // New events never accumulate in a per-subscriber queue while write() reports backpressure.
  const initialBytes = res.writableLength
  store.claim('fixture', { taskId: task.id, claimRequestId: 'worker' })
  assert.equal(res.writableLength, initialBytes)
  const keepAlive = setTimeout(() => {}, 1000)
  try { await once(res, 'close') } finally { clearTimeout(keepAlive) }
  assert.equal(res.destroyed, true)
  assert.deepEqual(store.events(task.id, 0).map(e => e.type), ['queued', 'claimed'])
})

test('drain resumes from the durable cursor, and idle subscribers receive heartbeat comments', async t => {
  const { store, task } = await fixture(t), res = new SlowResponse()
  const stop = streamChatEvents(store, {}, res, task.id, 0, { heartbeatMs: 10 })
  t.after(stop)
  store.claim('fixture', { taskId: task.id, claimRequestId: 'worker' })
  while (res.pending.length) res.release()
  assert.match(res.frames.join(''), /event: claimed/)
  await new Promise(resolve => setTimeout(resolve, 25))
  assert.match(res.frames.join(''), /: heartbeat/)
})
