import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { createCompletionStream, openAIComplete } from '../src/completion.js'
import { runAgent, toolDetail } from '../src/agent.js'
import { Workspace } from '../src/model.js'

const event = (delta, finish_reason = null) => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] }) + '\r\n\r\n'
async function server(t, handle) {
  const instance = createServer(handle)
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve))
  t.after(() => { instance.closeAllConnections(); instance.close() })
  return `http://127.0.0.1:${instance.address().port}/v1`
}
test('SSE delivers text before EOF and decodes split UTF-8 and CRLF', async t => {
  let ended = false, body
  const endpoint = await server(t, async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk
    body = JSON.parse(text)
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const bytes = Buffer.from(event({ content: '你好 🌟' }))
    for (let index = 0; index < bytes.length; index += 2) { response.write(bytes.subarray(index, index + 2)); await delay(1) }
    await delay(30); ended = true
    response.end(event({ content: '，完成' }, 'stop') + 'data: [DONE]\r\n\r\n')
  })
  const deltas = []
  const answer = await openAIComplete({ endpoint, model: 'fixture', messages: [], onDelta: delta => { if (!deltas.length) assert.equal(ended, false); deltas.push(delta.text) } })
  assert.equal(answer.content, '你好 🌟，完成'); assert.equal(deltas.join(''), answer.content)
  assert.equal(body.stream, true); assert.equal(body.reasoning_effort, 'medium')
})
test('interleaved tool argument fragments and reasoning are reassembled once', () => {
  const events = [], parser = createCompletionStream(delta => events.push(delta))
  const chunks = [
    event({ reasoning_content: '查看文件' }),
    event({ tool_calls: [{ index: 1, id: 'b', function: { name: 'read_file', arguments: '{"path":' } }, { index: 0, id: 'a', function: { name: 'list_files', arguments: '{' } }] }),
    event({ tool_calls: [{ index: 0, function: { arguments: '}' } }, { index: 1, function: { arguments: '"中文.js"}' } }] }, 'tool_calls'),
  ].join('')
  for (const char of chunks) parser.push(char)
  const answer = parser.finish()
  assert.deepEqual(answer.tool_calls.map(call => call.id), ['a', 'b'])
  assert.deepEqual(JSON.parse(answer.tool_calls[1].function.arguments), { path: '中文.js' })
  assert.deepEqual(events, [{ type: 'reasoning', text: '查看文件' }])
})
test('premature EOF preserves deltas and rejects unfinished tool calls', () => {
  const parser = createCompletionStream()
  parser.push(event({ content: '部分内容', tool_calls: [{ index: 0, id: 'a', function: { name: 'propose_file', arguments: '{' } }] }))
  assert.throws(() => parser.finish(), /提前结束/)
})
test('cancellation aborts an in-flight streamed response without losing prior text', async t => {
  let connectionClosed = false
  const endpoint = await server(t, (_request, response) => {
    response.on('close', () => { connectionClosed = true })
    response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(event({ content: '已接收' }))
  })
  const controller = new AbortController(), deltas = []
  await assert.rejects(openAIComplete({ endpoint, model: 'fixture', messages: [], signal: controller.signal,
    onDelta: delta => { deltas.push(delta.text); controller.abort(Error('手动停止')) },
  }), /手动停止/)
  await delay(50)
  assert.deepEqual(deltas, ['已接收']); assert.equal(connectionClosed, true)
})
test('only explicit reasoning parameter rejection retries and reports actual fallback', async () => {
  const bodies = [], notices = []
  const answer = await openAIComplete({ endpoint: 'https://fixture.invalid/v1', model: 'fixture', messages: [], reasoningEffort: 'ultra', onNotice: text => notices.push(text), request: async args => {
    bodies.push(JSON.parse(args.body))
    return bodies.length === 1 ? { status: 400, text: '{"error":{"message":"Unsupported value for reasoning_effort"}}' } : { status: 200, text: '{"choices":[{"message":{"content":"ok"}}]}' }
  } })
  assert.equal(answer.content, 'ok'); assert.equal(bodies[0].reasoning_effort, 'ultra'); assert.equal('reasoning_effort' in bodies[1], false); assert.match(notices[0], /模型默认/)
  let attempts = 0
  await assert.rejects(openAIComplete({ endpoint: 'https://fixture.invalid/v1', model: 'fixture', messages: [], request: async () => { attempts++; return { status: 400, text: 'invalid model' } } }), /HTTP 400/)
  assert.equal(attempts, 1)
})
test('agent stores parameters, live output, results and elapsed time without duplicate deltas', async () => {
  const events = [], workspace = new Workspace({ files: { 'main.js': 'console.log(1)' } })
  let turn = 0
  const answer = await runAgent({ workspace, messages: [], settings: { enabled: true, files: true, execute: true },
    complete: async ({ onDelta }) => {
      if (!turn++) return { tool_calls: [{ id: 'run-1', function: { name: 'run_project', arguments: '{"command":"main.js"}' } }] }
      onDelta({ type: 'text', text: '完' }); onDelta({ type: 'text', text: '成' }); return { content: '完成' }
    },
    execute: async (_command, _signal, onOutput) => { onOutput('first\n'); await delay(5); onOutput('second\n'); return { output: 'first\nsecond\n', exitCode: 0 } },
    onEvent: event => events.push(event),
  })
  assert.equal(answer.content, '完成'); assert.equal(events.filter(item => item.type === 'text').map(item => item.text).join(''), '完成')
  const result = events.find(item => item.phase === 'complete')
  assert.match(result.input, /main.js/); assert.match(result.result, /exitCode/); assert.ok(result.duration >= 0)
  assert.equal(result.output, 'first\nsecond\n'); assert.ok(events.some(item => item.phase === 'running' && item.output === 'first\n'))
})
test('tool details redact credential fields and bound retained output', () => {
  const text = toolDetail({ api_key: 'private-key', nested: { token: 'private-token' }, output: 'Authorization: Bearer private-value' })
  assert.doesNotMatch(text, /private-/)
  assert.match(toolDetail('x'.repeat(21000)), /详情已截断/)
})
