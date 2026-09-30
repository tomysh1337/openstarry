import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { startPublicGateway } from '../public-gateway.mjs'

test('public gateway forwards only the exact MCP capability and health path', async t => {
  const calls = []
  const upstream = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    calls.push({ path: req.url, host: req.headers.host, auth: req.headers.authorization, bytes: Buffer.concat(chunks).toString() })
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true }))
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const localOrigin = 'http://127.0.0.1:' + upstream.address().port
  const mcpPath = '/mcp/' + 'a'.repeat(43)
  const gateway = await startPublicGateway({ mcpUrl: localOrigin + mcpPath, port: 0 })
  t.after(async () => { await gateway.close(); await new Promise(resolve => upstream.close(resolve)) })
  for (const path of ['/admin/tasks', '/admin/chat/tasks', '/admin/chat/adapters', '/adapter-mcp/' + 'c'.repeat(43), '/admin/proposals/x/accept', mcpPath + '/../admin/tasks', '/mcp/bad', mcpPath + '?redirect=/admin']) {
    assert.equal((await fetch(gateway.origin + path, { method: 'POST', headers: { authorization: 'Bearer local-admin-token' }, body: '{}' })).status, 404)
  }
  assert.equal(calls.length, 0)
  const response = await fetch(gateway.origin + mcpPath, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer must-not-forward' }, body: '{"jsonrpc":"2.0","id":1}' })
  assert.equal(response.status, 200)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].host, new URL(localOrigin).host)
  assert.equal(calls[0].auth, undefined)
  assert.equal(calls[0].bytes, '{"jsonrpc":"2.0","id":1}')
  assert.equal((await fetch(gateway.origin + '/health')).status, 200)
})

test('origins, header spoofing, methods and body sizes are checked at the public boundary', async t => {
  const upstream = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}') })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const path = '/mcp/' + 'b'.repeat(43)
  const gateway = await startPublicGateway({ mcpUrl: 'http://127.0.0.1:' + upstream.address().port + path, port: 0 })
  t.after(async () => { await gateway.close(); await new Promise(resolve => upstream.close(resolve)) })
  assert.equal((await fetch(gateway.origin + path, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' })).status, 403)
  gateway.setPublicOrigin('https://test.trycloudflare.com')
  assert.equal((await fetch(gateway.origin + path, { method: 'POST', headers: { origin: 'https://test.trycloudflare.com', 'content-type': 'application/json' }, body: '{}' })).status, 200)
  assert.equal((await fetch(gateway.origin + path, { method: 'PUT' })).status, 405)
  assert.equal((await fetch(gateway.origin + path, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status, 415)
  assert.equal((await fetch(gateway.origin + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(256 * 1024 + 1) })).status, 413)
})
