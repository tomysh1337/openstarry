import { DatabaseSync } from 'node:sqlite'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { problem } from './store.mjs'
import { artifactList } from './artifacts.mjs'

export const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/)
export const taskInput = z.object({ clientId: identifier, adapterId: identifier, sessionId: identifier, messageId: identifier, requestId: identifier, prompt: z.string().trim().min(1).max(16000), thinking: z.boolean().optional(), fileTaskId: z.string().uuid().optional(),
  subagent: z.object({ parentTaskId: z.string().uuid(), name: z.string().min(1).max(80), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict().optional() }).strict()
export const adapterInput = z.object({ adapterId: identifier, source: z.enum(['fixture', 'chatgpt-web']) }).strict()
const empty = z.object({}).strict()
const webId = z.string().regex(/^[a-zA-Z0-9_-]{1,220}$/)
const toolId = { toolId: identifier }
const eventPayloads = {
  dispatching: empty,
  started: z.object({ webConversationId: webId }).strict(),
  resumed: z.object({ webConversationId: webId }).strict(),
  text_delta: z.object({ text: z.string().min(1) }).strict(),
  text_snapshot: z.object({ text: z.string() }).strict(),
  file_links: z.object({ artifacts: artifactList }).strict(),
  tool_started: z.object({ ...toolId, name: z.string().min(1).max(120), input: z.string().max(8000).optional(), provider: z.string().max(120).optional(), startedAt: z.string().datetime().optional() }).strict(),
  tool_updated: z.object({ ...toolId, output: z.string().max(8000) }).strict(),
  tool_completed: z.object({ ...toolId, output: z.string().max(8000), error: z.boolean().optional(), durationMs: z.number().nonnegative().optional() }).strict(),
  proposal_pending: z.object({ proposalId: z.string().uuid() }).strict(),
  completed: empty,
  error: z.object({ message: z.string().min(1).max(2000), code: identifier.optional() }).strict(),
  cancelled: empty
}
export const eventInput = z.object({ taskId: z.string().uuid(), claimToken: z.string().min(1).max(100), clientSeq: z.number().int().positive(), eventId: identifier, type: z.enum(Object.keys(eventPayloads)), payload: z.record(z.unknown()) }).strict()
export function parse(schema, value) {
  const result = schema.safeParse(value)
  if (!result.success) throw problem('INVALID_INPUT', 'Fields do not match the chat protocol')
  return result.data
}
const terminal = new Set(['completed', 'error', 'cancelled'])
const hash = value => createHash('sha256').update(value).digest('hex')
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)
const publicTask = task => { const { claimToken, claimRequestId, requestHash, ...visible } = task; return visible }

// A separate transactional journal leaves the existing file-review state untouched.
export function openChatStore({ stateDir, now = Date.now, leaseMs = 30000, retainEvents = 256, retainBytes = 256 * 1024, maxTextBytes = 1024 * 1024, maxEventBytes = 64 * 1024, maxTasks = 200, maxEvents = 10000 }) {
  const db = new DatabaseSync(join(stateDir, 'chat.sqlite'))
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;
    CREATE TABLE IF NOT EXISTS adapters (id TEXT PRIMARY KEY, source TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL);
    CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, request_id TEXT NOT NULL, session_id TEXT NOT NULL, message_id TEXT NOT NULL, data TEXT NOT NULL,
      UNIQUE(client_id, request_id), UNIQUE(client_id, session_id, message_id));
    CREATE TABLE IF NOT EXISTS sessions (client_id TEXT NOT NULL, session_id TEXT NOT NULL, adapter_id TEXT NOT NULL, web_id TEXT, PRIMARY KEY(client_id, session_id));
    CREATE TABLE IF NOT EXISTS events (task_id TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY(task_id, seq));
    CREATE TABLE IF NOT EXISTS receipts (task_id TEXT NOT NULL, event_id TEXT NOT NULL, hash TEXT NOT NULL, ack TEXT NOT NULL, PRIMARY KEY(task_id, event_id));`)
  const listeners = new Set()
  let closed = false
  const readTask = id => {
    const row = db.prepare('SELECT data FROM tasks WHERE id=?').get(id)
    if (!row) throw problem('NOT_FOUND', 'Chat task not found', 404)
    return JSON.parse(row.data)
  }
  const all = () => db.prepare('SELECT data FROM tasks ORDER BY rowid').all().map(row => JSON.parse(row.data))
  const save = task => db.prepare('UPDATE tasks SET data=? WHERE id=?').run(JSON.stringify(task), task.id)
  const transaction = fn => {
    db.exec('BEGIN IMMEDIATE')
    try { const result = fn(); db.exec('COMMIT'); return result }
    catch (error) { db.exec('ROLLBACK'); throw error }
  }
  const publish = id => { for (const listener of listeners) listener(id) }
  const timestamp = () => new Date(now()).toISOString()
  function record(task, type, payload = {}, eventId = randomUUID()) {
    task.lastSeq++; task.updatedAt = timestamp()
    if (terminal.has(task.status) && !task.finishedAt) task.finishedAt = task.updatedAt
    const event = { protocolVersion: 1, taskId: task.id, clientId: task.clientId, sessionId: task.sessionId, messageId: task.messageId, requestId: task.requestId,
      source: task.source, seq: task.lastSeq, eventId, timestamp: task.updatedAt, type, payload }
    const encoded = JSON.stringify(event)
    db.prepare('INSERT INTO events VALUES (?,?,?,?)').run(task.id, event.seq, encoded, Buffer.byteLength(encoded))
    // Retain a bounded replay window; the current snapshot and small retry receipts outlive it.
    const rows = db.prepare('SELECT seq,bytes FROM events WHERE task_id=? ORDER BY seq DESC').all(task.id)
    let bytes = 0, oldest = event.seq
    for (const [index, row] of rows.entries()) {
      if (index >= retainEvents || (index > 0 && bytes + row.bytes > retainBytes)) break
      bytes += row.bytes; oldest = row.seq
    }
    db.prepare('DELETE FROM events WHERE task_id=? AND seq<?').run(task.id, oldest)
    save(task)
    return event
  }
  const owned = (adapterId, taskId, token) => {
    const task = readTask(taskId)
    if (task.adapterId !== adapterId) throw problem('ADAPTER_DENIED', 'Task belongs to another adapter', 403)
    if (token !== undefined && task.claimToken !== token) throw problem('CLAIM_DENIED', 'Claim belongs to another worker', 403)
    return task
  }
  const session = task => db.prepare('SELECT * FROM sessions WHERE client_id=? AND session_id=?').get(task.clientId, task.sessionId)
  const ensureOpen = task => { if (terminal.has(task.status)) throw problem('TASK_CLOSED', 'Chat task is terminal', 409) }
  function mapConversation(task, id) {
    const mapping = session(task)
    if (mapping.web_id && mapping.web_id !== id) throw problem('SESSION_CONFLICT', 'Web conversation does not match this session', 409)
    if (db.prepare('SELECT 1 FROM sessions WHERE adapter_id=? AND web_id=? AND NOT (client_id=? AND session_id=?)').get(task.adapterId, id, task.clientId, task.sessionId)) {
      throw problem('SESSION_CONFLICT', 'Web conversation is already bound to another session', 409)
    }
    db.prepare('UPDATE sessions SET web_id=? WHERE client_id=? AND session_id=?').run(id, task.clientId, task.sessionId)
    task.webConversationId = id
  }
  // A persisted dispatch intent may already have reached the webpage. Never requeue it.
  transaction(() => {
    for (const task of all()) {
      if (terminal.has(task.status) || task.delivery === 'not_sent') continue
      if (task.status !== 'cancel_requested') task.status = 'interrupted'
      record(task, 'interrupted', { reason: 'service_restarted', cancelRequested: task.status === 'cancel_requested' })
    }
  })
  return {
    register(value) {
      const input = parse(adapterInput, value), token = randomBytes(32).toString('base64url')
      if (db.prepare('SELECT 1 FROM adapters WHERE id=?').get(input.adapterId)) throw problem('ADAPTER_EXISTS', 'Adapter id already registered', 409)
      if (db.prepare('SELECT COUNT(*) AS n FROM adapters').get().n >= 32) throw problem('ADAPTER_LIMIT', 'Adapter limit reached', 409)
      db.prepare('INSERT INTO adapters VALUES (?,?,?)').run(input.adapterId, input.source, hash(token))
      return { ...input, token }
    },
    authenticate(token) { return typeof token === 'string' && /^[\w-]{43}$/.test(token) ? db.prepare('SELECT id FROM adapters WHERE token_hash=?').get(hash(token))?.id : undefined },
    adapters: () => db.prepare('SELECT id AS adapterId,source FROM adapters').all(),
    // Lists contain routing/status metadata; fetch or claim one task to read its content.
    list: (adapterId, { progress = false } = {}) => ({ tasks: db.prepare(`SELECT json_remove(data, '$.claimToken', '$.claimRequestId', '$.requestHash', '$.prompt', '$.text', '$.tools') AS data
      ${progress ? `, length(json_extract(data, '$.text')) AS characters, substr(json_extract(data, '$.text'), -240) AS preview,
        (SELECT count(*) FROM json_each(json_extract(tasks.data, '$.tools'))) AS toolCount,
        (SELECT json_extract(value, '$.name') FROM json_each(json_extract(tasks.data, '$.tools')) WHERE json_extract(value, '$.status')='running' LIMIT 1) AS activeTool` : ''}
      FROM tasks WHERE (? IS NULL OR json_extract(data, '$.adapterId')=?) ORDER BY rowid`).all(adapterId ?? null, adapterId ?? null).map(row => ({ ...JSON.parse(row.data), ...(progress ? { progress: { characters: row.characters, preview: row.preview, toolCount: row.toolCount, activeTool: row.activeTool } } : {}) })) }),
    get: id => publicTask(readTask(id)),
    linkFileTask(id, fileTaskId) {
      transaction(() => {
        const task = readTask(id); task.connectorTaskIds ||= []
        if (!task.connectorTaskIds.includes(fileTaskId) && task.connectorTaskIds.length < 32) { task.connectorTaskIds.push(fileTaskId); save(task) }
      })
    },
    observeTool(id, type, value) {
      const payload = parse(eventPayloads[type], value)
      const observed = transaction(() => {
        const task = readTask(id)
        if (terminal.has(task.status)) return false
        const previous = task.tools[payload.toolId]
        if (type === 'tool_started' ? previous || Object.keys(task.tools).length >= 32 : !previous || previous.status === 'completed') return false
        const tool = { ...previous, ...payload, status: type === 'tool_completed' ? 'completed' : 'running' }
        if (Buffer.byteLength(JSON.stringify({ ...task.tools, [payload.toolId]: tool })) > 256 * 1024) return false
        task.tools[payload.toolId] = tool; record(task, type, payload); return true
      })
      if (observed) publish(id)
      return observed
    },
    submit(value) {
      const input = parse(taskInput, value), requestHash = hash(canonical(input))
      const task = transaction(() => {
        const existing = db.prepare('SELECT data FROM tasks WHERE client_id=? AND request_id=?').get(input.clientId, input.requestId)
        if (existing) {
          const task = JSON.parse(existing.data)
          if (task.requestHash !== requestHash) throw problem('REQUEST_CONFLICT', 'Request id already has different content', 409)
          return task
        }
        if (db.prepare('SELECT 1 FROM tasks WHERE client_id=? AND session_id=? AND message_id=?').get(input.clientId, input.sessionId, input.messageId)) throw problem('MESSAGE_CONFLICT', 'Message id already submitted', 409)
        const adapter = db.prepare('SELECT source FROM adapters WHERE id=?').get(input.adapterId)
        if (!adapter) throw problem('ADAPTER_MISSING', 'Register a local adapter first', 409)
        if (db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n >= maxTasks) throw problem('QUEUE_FULL', 'Chat task limit reached; export history before creating a new fixture', 409)
        const previous = session(input)
        if (previous && previous.adapter_id !== input.adapterId) throw problem('SESSION_CONFLICT', 'Session is bound to another adapter', 409)
        if (!previous) db.prepare('INSERT INTO sessions VALUES (?,?,?,NULL)').run(input.clientId, input.sessionId, input.adapterId)
        const task = { ...input, id: randomUUID(), source: adapter.source, kind: 'chat', status: 'queued', delivery: 'not_sent', requestHash,
          webConversationId: previous?.web_id ?? null, text: '', artifacts: [], tools: {}, proposals: [], lastSeq: 0, clientSeq: 0, leaseUntil: 0, createdAt: timestamp(), updatedAt: timestamp() }
        if (input.subagent) task.kind = 'subagent'
        db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?)').run(task.id, task.clientId, task.requestId, task.sessionId, task.messageId, JSON.stringify(task))
        record(task, 'queued'); return task
      })
      publish(task.id); return publicTask(task)
    },
    claim(adapterId, { taskId, claimRequestId }) {
      const result = transaction(() => {
        const task = owned(adapterId, taskId); ensureOpen(task)
        if (task.status === 'cancel_requested') throw problem('CANCEL_REQUESTED', 'Confirm cancellation before further work', 409)
        if (task.claimRequestId === claimRequestId) return { task: publicTask(task), claimToken: task.claimToken }
        if (task.delivery !== 'not_sent') throw problem('DELIVERY_UNCERTAIN', 'Dispatch already recorded; reconcile the existing webpage instead of sending again', 409)
        if (task.claimToken && task.leaseUntil > now()) throw problem('CLAIM_CONFLICT', 'Task is held by another worker', 409)
        const earlier = all().filter(t => t.clientId === task.clientId && t.sessionId === task.sessionId)
        if (earlier.slice(0, earlier.findIndex(t => t.id === task.id)).some(t => !terminal.has(t.status))) throw problem('SESSION_BUSY', 'An earlier message in this session is unfinished', 409)
        task.claimToken = randomBytes(32).toString('base64url'); task.claimRequestId = claimRequestId; task.leaseUntil = now() + leaseMs
        task.status = 'waiting_web'; task.webConversationId = session(task).web_id
        record(task, 'claimed', { leaseUntil: task.leaseUntil })
        return { task: publicTask(task), claimToken: task.claimToken }
      })
      publish(taskId); return result
    },
    heartbeat(adapterId, { taskId, claimToken }) {
      const task = owned(adapterId, taskId, claimToken)
      if (!terminal.has(task.status)) { task.leaseUntil = now() + leaseMs; save(task) }
      return { task: publicTask(task), cancelRequested: task.status === 'cancel_requested' }
    },
    append(adapterId, value) {
      const input = parse(eventInput, value), payload = parse(eventPayloads[input.type], input.payload)
      const fingerprint = hash(canonical({ type: input.type, payload, clientSeq: input.clientSeq }))
      if (Buffer.byteLength(JSON.stringify(payload)) > maxEventBytes) throw problem('EVENT_LIMIT', 'Event exceeds the byte limit', 413)
      const ack = transaction(() => {
        const task = owned(adapterId, input.taskId, input.claimToken)
        const receipt = db.prepare('SELECT hash,ack FROM receipts WHERE task_id=? AND event_id=?').get(task.id, input.eventId)
        if (receipt) {
          if (receipt.hash !== fingerprint) throw problem('EVENT_CONFLICT', 'Event id already has different content', 409)
          return JSON.parse(receipt.ack)
        }
        ensureOpen(task)
        if (input.clientSeq !== task.clientSeq + 1) throw problem('EVENT_ORDER', 'Expected clientSeq ' + (task.clientSeq + 1), 409)
        if (input.clientSeq > maxEvents && !['error', 'cancelled', 'completed'].includes(input.type)) throw problem('EVENT_LIMIT', 'Event count limit reached; finish this task', 409)
        const generating = task.delivery === 'sent' && ['generating', 'cancel_requested'].includes(task.status)
        if (input.type === 'dispatching') {
          if (task.status !== 'waiting_web' || task.delivery !== 'not_sent' || task.leaseUntil <= now()) throw problem('INVALID_TRANSITION', 'Claim must be current before dispatch', 409)
          task.delivery = 'dispatching'; task.status = 'sending'
        } else if (input.type === 'started' || input.type === 'resumed') {
          if (input.type === 'started' ? task.delivery !== 'dispatching' : task.status !== 'interrupted') throw problem('INVALID_TRANSITION', 'Check webpage delivery before starting or resuming', 409)
          mapConversation(task, payload.webConversationId); task.delivery = 'sent'
          if (task.status !== 'cancel_requested') task.status = 'generating'
        } else if (input.type === 'error') {
          task.status = 'error'; task.error = payload
        } else if (input.type === 'cancelled') {
          if (task.status !== 'cancel_requested') throw problem('INVALID_TRANSITION', 'No cancellation was requested', 409)
          task.status = 'cancelled'
        } else {
          if (!generating) throw problem('INVALID_TRANSITION', 'Observe webpage generation before reporting content', 409)
          if (input.type === 'text_delta' || input.type === 'text_snapshot') {
            const text = input.type === 'text_delta' ? task.text + payload.text : payload.text
            if (Buffer.byteLength(text) > maxTextBytes) throw problem('TEXT_LIMIT', 'Answer snapshot exceeds the byte limit', 413)
            task.text = text
          } else if (input.type === 'file_links') {
            task.artifacts = payload.artifacts
          } else if (input.type.startsWith('tool_')) {
            const previous = Object.hasOwn(task.tools, payload.toolId) ? task.tools[payload.toolId] : undefined
            if (input.type === 'tool_started') {
              if (previous) throw problem('TOOL_CONFLICT', 'Tool is already present', 409)
              if (Object.keys(task.tools).length >= 32) throw problem('TOOL_LIMIT', 'Tool record limit reached', 409)
            } else if (!previous || previous.status === 'completed') throw problem('TOOL_CONFLICT', 'Tool is missing or already complete', 409)
            Object.defineProperty(task.tools, payload.toolId, { value: { ...previous, ...payload, status: input.type === 'tool_completed' ? 'completed' : 'running' }, enumerable: true, configurable: true, writable: true })
            if (Buffer.byteLength(JSON.stringify(task.tools)) > 256 * 1024) throw problem('TOOL_LIMIT', 'Tool details exceed the byte limit', 413)
          } else if (input.type === 'proposal_pending') {
            if (!task.proposals.includes(payload.proposalId)) {
              if (task.proposals.length >= 32) throw problem('PROPOSAL_LIMIT', 'Proposal reference limit reached', 409)
              task.proposals.push(payload.proposalId)
            }
          } else if (input.type === 'completed') task.status = 'completed'
        }
        task.clientSeq = input.clientSeq; task.leaseUntil = now() + leaseMs
        const event = record(task, input.type, payload, input.eventId)
        const ack = { taskId: task.id, eventId: input.eventId, clientSeq: input.clientSeq, seq: event.seq }
        db.prepare('INSERT INTO receipts VALUES (?,?,?,?)').run(task.id, input.eventId, fingerprint, JSON.stringify(ack))
        return ack
      })
      publish(input.taskId); return ack
    },
    cancel(id) {
      const task = transaction(() => {
        const task = readTask(id)
        if (terminal.has(task.status) || task.status === 'cancel_requested') return task
        task.status = task.delivery === 'not_sent' ? 'cancelled' : 'cancel_requested'
        record(task, task.status, { reason: task.delivery === 'not_sent' ? 'not_dispatched' : 'local_user' }); return task
      })
      publish(id); return publicTask(task)
    },
    events(id, after) {
      const task = readTask(id)
      if (!Number.isSafeInteger(after) || after < 0) throw problem('INVALID_CURSOR', 'Cursor must be a non-negative integer')
      if (after > task.lastSeq) throw problem('CURSOR_AHEAD', 'Cursor exceeds this task sequence', 409)
      const first = db.prepare('SELECT MIN(seq) AS seq FROM events WHERE task_id=?').get(id).seq
      if (after < first - 1) return [{ type: 'reset', taskId: id, seq: task.lastSeq, snapshot: publicTask(task) }]
      return db.prepare('SELECT data FROM events WHERE task_id=? AND seq>? ORDER BY seq').all(id, after).map(row => JSON.parse(row.data))
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    close() { if (!closed) { closed = true; listeners.clear(); db.close() } }
  }
}
