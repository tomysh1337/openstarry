import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { streamHttp } from '../src/main/app/streamHttp.mjs'

async function serve(t, handle) {
  const server = createServer(handle)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  return `http://127.0.0.1:${server.address().port}`
}
test('ongoing reasoning survives longer than the idle timeout and returns final text', async (t) => {
  const url = await serve(t, async (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (let i = 0; i < 8; i++) {
      res.write('data: {"reasoning":"思考"}\n\n')
      await delay(30)
    }
    res.end('data: {"content":"完成"}\n\ndata: [DONE]\n\n')
  })
  let received = ''
  const result = await streamHttp({
    url,
    stream: true,
    idleTimeoutMs: 150,
    controller: new AbortController(),
    onChunk: (value) => {
      received += value
    }
  })
  assert.equal(result.streamed, true)
  assert.equal(received.match(/思考/g).length, 8)
  assert.match(received, /完成/)
})
test('stalled streams fail clearly and user cancellation remains immediate', async (t) => {
  const url = await serve(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(': ready\n\n')
  })
  await assert.rejects(
    streamHttp({ url, stream: true, idleTimeoutMs: 100, controller: new AbortController() }),
    /长时间没有返回/
  )
  const controller = new AbortController()
  await assert.rejects(
    streamHttp({
      url,
      stream: true,
      controller,
      onChunk: () => controller.abort(Error('用户停止'))
    }),
    /用户停止/
  )
})
