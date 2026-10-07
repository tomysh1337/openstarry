import test from 'node:test'
import assert from 'node:assert/strict'
import { createIdeHttpRequest } from '../src/renderer/src/chat/ideHttp.mjs'
import { createCompletionStream } from '../../../SHARED/workbench/src/completion.js'
test('late final IPC chunks after invoke completion are parsed before unsubscribing', async () => {
  let listener,
    detached = false
  const parser = createCompletionStream()
  const api = {
    cancelHttp: async () => {},
    onHttpChunk: (fn) => {
      listener = fn
      return () => {
        detached = true
      }
    },
    http: async ({ id }) => {
      listener({
        id,
        seq: 1,
        text: 'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\n\n'
      })
      setTimeout(() => {
        assert.equal(detached, false)
        listener({
          id,
          seq: 2,
          text: 'data: {"choices":[{"delta":{"content":"complete"},"finish_reason":"stop"}]}\n\n'
        })
      }, 20)
      return { lastSeq: 2, status: 200, streamed: true }
    }
  }
  await createIdeHttpRequest(api)({ url: 'http://fixture', onChunk: (text) => parser.push(text) })
  assert.equal(parser.finish().content, 'complete')
  assert.equal(detached, true)
})
test('cancellation during final IPC drain detaches without waiting five seconds', async () => {
  let detached = false
  const controller = new AbortController()
  const api = {
    cancelHttp: async () => {},
    onHttpChunk: () => () => {
      detached = true
    },
    http: async () => {
      setTimeout(() => controller.abort(Error('cancelled')), 10)
      return { lastSeq: 1 }
    }
  }
  await assert.rejects(
    createIdeHttpRequest(api)({ signal: controller.signal, onChunk: () => {} }),
    /cancelled/
  )
  assert.equal(detached, true)
})
