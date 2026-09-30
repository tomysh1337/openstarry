import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { eventInput, identifier } from './chat-store.mjs'
import { problem } from './store.mjs'

export function chatMcpServer(chat, adapterId) {
  const server = new McpServer({ name: 'openstarry-chat-adapter', version: '0.2.0' })
  const taskId = z.string().uuid(), claimToken = z.string().min(1).max(100)
  const register = (name, description, inputSchema, readOnlyHint, fn) => server.registerTool(name, {
    description, inputSchema, annotations: { readOnlyHint, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async args => {
    try { return { content: [{ type: 'text', text: JSON.stringify(fn(args)) }] } }
    catch (error) { return { isError: true, content: [{ type: 'text', text: error.status ? error.message : 'LOCAL_ERROR: Chat operation failed' }] } }
  })
  register('list_chat_tasks', 'Read this adapter’s chat tasks. Only a claim grants permission to send; reconcile interrupted delivery before sending again.', {}, true, () => chat.list(adapterId))
  register('claim_chat_task', 'Claim one task. Persist the returned claim token. Append dispatching and await its acknowledgement BEFORE sending to the webpage.', { taskId, claimRequestId: identifier }, false, a => chat.claim(adapterId, a))
  register('heartbeat_chat_task', 'Renew an owned claim and check cancellation. Poll during generation; cancelled is emitted only after observing stop on the webpage.', { taskId, claimToken }, false, a => chat.heartbeat(adapterId, a))
  register('append_chat_event', 'Append an observed webpage event. Retry identical eventId/clientSeq on connection failure. Never fabricate content or progress; fixture adapters remain labelled fixture.', eventInput.shape, false, a => chat.append(adapterId, a))
  return server
}

// Keep only a cursor per connection. Backpressure pauses reads from the durable journal.
export function streamChatEvents(chat, req, res, taskId, after, { heartbeatMs = 15000, slowTimeoutMs = 5000, maxBufferedBytes = 2 * 1024 * 1024, onClose = () => {} } = {}) {
  chat.events(taskId, after)
  let cursor = after, stalled = false, ended = false, stallTimer, heartbeat, unsubscribe = () => {}
  const cleanup = () => {
    if (ended) return
    ended = true; clearInterval(heartbeat); clearTimeout(stallTimer); unsubscribe(); res.off('drain', drain); onClose()
  }
  const stop = () => { cleanup(); res.destroy() }
  const write = text => {
    if (ended) return false
    if (res.writableLength + Buffer.byteLength(text) > maxBufferedBytes) { stop(); return false }
    const ready = res.write(text)
    if (!ready) { stalled = true; stallTimer = setTimeout(stop, slowTimeoutMs); stallTimer.unref?.() }
    return ready
  }
  const pump = () => {
    if (ended || stalled) return
    try {
      for (const event of chat.events(taskId, cursor)) {
        cursor = event.seq
        if (!write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)) return
      }
      if (['completed', 'error', 'cancelled'].includes(chat.get(taskId).status)) { cleanup(); res.end() }
    } catch { stop() }
  }
  function drain() { if (ended) return; stalled = false; clearTimeout(stallTimer); pump() }
  res.on('drain', drain); res.once('close', cleanup); res.once('error', stop)
  unsubscribe = chat.subscribe(id => { if (id === taskId) pump() })
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-accel-buffering': 'no' })
  res.flushHeaders()
  write('retry: 1000\n\n')
  heartbeat = setInterval(() => { if (!stalled && !ended) write(': heartbeat\n\n') }, heartbeatMs)
  heartbeat.unref?.(); pump()
  return stop
}

export function cursorFrom(url, req) {
  const raw = req.headers['last-event-id'] ?? url.searchParams.get('after') ?? '0'
  if (typeof raw !== 'string' || !/^\d{1,16}$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw problem('INVALID_CURSOR', 'Use a non-negative integer event cursor')
  return Number(raw)
}
