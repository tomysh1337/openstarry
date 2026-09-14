import assert from 'node:assert/strict'
import test from 'node:test'

import {
  collectLocalChanges,
  mergeQueue,
  recordHash,
  stableStringify,
  validateSyncConfig
} from '../src/main/app/syncProtocol.mjs'

test('stable serialization and hashes ignore object key order', () => {
  assert.equal(stableStringify({ b: 2, a: 1 }), '{"a":1,"b":2}')
  assert.equal(
    recordHash({ id: 'conversation:1', kind: 'conversation', payload: { b: 2, a: 1 } }),
    recordHash({ id: 'conversation:1', kind: 'conversation', payload: { a: 1, b: 2 } })
  )
})

test('local changes are incremental and hard removals become tombstones', () => {
  const original = {
    id: 'conversation:1',
    kind: 'conversation',
    deleted: false,
    payload: { conversation_uid: '1', title: 'A' }
  }
  const first = collectLocalChanges([original], {}, 100, 'desktop')
  assert.equal(first.operations.length, 1)
  const unchanged = collectLocalChanges([original], first.hashes, 200, 'desktop')
  assert.equal(unchanged.operations.length, 0)
  const removed = collectLocalChanges([], first.hashes, 300, 'desktop')
  assert.equal(removed.operations[0].record.deleted, true)
})

test('offline queue keeps the newest version of each record', () => {
  const record = { id: 'conversation:1', kind: 'conversation', payload: {} }
  const queue = mergeQueue(
    [{ opId: 'old', modifiedAt: 1, deviceId: 'a', record }],
    [{ opId: 'new', modifiedAt: 2, deviceId: 'b', record }]
  )
  assert.deepEqual(
    queue.map((item) => item.opId),
    ['new']
  )
})

test('remote sync requires HTTPS while localhost may use HTTP', () => {
  assert.throws(
    () =>
      validateSyncConfig({
        enabled: true,
        serverUrl: 'http://example.com',
        userId: 'a'
      }),
    /HTTPS/
  )
  assert.equal(
    validateSyncConfig({
      enabled: true,
      serverUrl: 'http://127.0.0.1:8787/',
      userId: 'a',
      intervalMinutes: 0
    }).serverUrl,
    'http://127.0.0.1:8787'
  )
})
