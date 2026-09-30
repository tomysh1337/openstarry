import { readFile, writeFile, rename } from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'
import { join } from 'node:path'
import { ConnectionConfig, Sandbox } from '@alibaba-group/opensandbox'
import { z } from 'zod'
import { problem } from './store.mjs'

export const sandboxRunInput = z.object({ task_id: z.string().uuid(), request_id: z.string().min(1).max(220), command: z.string().min(1).max(16000), network: z.boolean().default(false), timeout_seconds: z.number().int().min(1).max(300).default(120) }).strict()
export const sandboxReadInput = z.object({ task_id: z.string().uuid(), execution_id: z.string().uuid(), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(16000).default(8000) }).strict()
const done = job => ['completed', 'error', 'cancelled', 'interrupted', 'rejected'].includes(job.status)

export async function openSandboxRunner({ stateDir, configPath, policy, files, isCancelled = () => false, create = options => Sandbox.create(options) }) {
  const statePath = join(stateDir, 'sandbox-jobs.json')
  let jobs = await readFile(statePath, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return []; throw error })
  if (!Array.isArray(jobs)) throw Error('Invalid sandbox job journal')
  for (const job of jobs) if (['queued', 'running', 'cancel_requested'].includes(job.status)) { job.status = 'interrupted'; job.error = 'Service restarted; command was not retried. Its sandbox expires by TTL.' }
  let sequence = Promise.resolve(), closed = false
  const active = new Map()
  const serial = fn => { const next = sequence.then(fn); sequence = next.catch(() => {}); return next }
  async function save() { const temp = statePath + '.tmp'; await writeFile(temp, JSON.stringify(jobs), { mode: 0o600 }); await rename(temp, statePath) }
  await save()
  async function config() {
    if (!configPath) throw problem('SANDBOX_SETUP_REQUIRED', 'Run the local OpenSandbox setup first', 503)
    const value = await readFile(configPath, 'utf8').then(JSON.parse).catch(() => { throw problem('SANDBOX_SETUP_REQUIRED', 'Local OpenSandbox connection has not been prepared', 503) })
    if (!/^127\.0\.0\.1:\d{2,5}$/.test(value.domain) || typeof value.apiKey !== 'string' || value.apiKey.length < 32) throw problem('SANDBOX_CONFIG', 'Local OpenSandbox connection settings need repair', 503)
    return value
  }
  const summary = job => ({ id: job.id, task_id: job.task_id, status: job.status, command: job.command.slice(0, 160), network: job.network, timeout_seconds: job.timeout_seconds, createdAt: job.createdAt, startedAt: job.startedAt, finishedAt: job.finishedAt, durationMs: job.durationMs, done: done(job), error: job.error, cleanupError: job.cleanupError })
  const find = (id, taskId) => { const job = jobs.find(j => j.id === id && (!taskId || j.task_id === taskId)); if (!job) throw problem('NOT_FOUND', 'Sandbox execution not found for this task', 404); return job }
  const allowed = job => { const mode = policy().safetyMode; return mode === 'full' || (mode === 'auto' && !job.network) }
  function launch(job, approved = false) {
    const controller = new AbortController()
    const work = execute(job, controller, approved).catch(() => {
      // The durable running receipt prevents a repeated command after storage failure.
      job.status = 'interrupted'; job.error = 'Sandbox journal failed; inspect the execution before retrying.'
    }).finally(() => active.delete(job.id))
    active.set(job.id, { controller, work })
  }
  async function execute(job, controller, approved) {
    let sandbox, timer
    try {
      const settings = await config()
      await serial(async () => {
        if (controller.signal.aborted) return
        if (!approved && !allowed(job)) { job.status = 'awaiting_approval'; await save(); return }
        job.status = 'running'; job.startedAt = new Date().toISOString(); await save()
      })
      if (job.status !== 'running' || controller.signal.aborted) return
      timer = setTimeout(() => controller.abort(), (job.timeout_seconds + 90) * 1000)
      sandbox = await create({ connectionConfig: new ConnectionConfig({ domain: settings.domain, apiKey: settings.apiKey, protocol: 'http', useServerProxy: true, requestTimeoutSeconds: 30 }), image: settings.image || 'python:3.12-slim', entrypoint: ['sh', '-c', 'sleep infinity'], timeoutSeconds: job.timeout_seconds + 120, resource: { cpu: '1', memory: '512Mi' }, networkPolicy: { defaultAction: job.network ? 'allow' : 'deny', egress: [] }, signal: controller.signal })
      await serial(async () => { job.sandboxId = sandbox.id; await save() })
      if (controller.signal.aborted) throw Error('Cancelled')
      const append = (stream, msg) => serial(async () => {
        const bytes = Buffer.from((stream === 'stderr' ? '[stderr] ' : '') + String(msg.text || ''))
        const remaining = Math.max(0, 65536 - Buffer.byteLength(job.output))
        job.output += new TextDecoder().decode(bytes.subarray(0, remaining), { stream: true })
        if (bytes.length > remaining) job.truncated = true
        await save()
      })
      const result = await sandbox.commands.run(job.command, { timeoutSeconds: job.timeout_seconds }, { skipAccumulation: true, onStdout: msg => append('stdout', msg), onStderr: msg => append('stderr', msg) }, controller.signal)
      await serial(async () => {
        job.exitCode = result.exitCode ?? null
        job.status = controller.signal.aborted ? 'cancelled' : result.error || (result.exitCode != null && result.exitCode !== 0) ? 'error' : result.complete ? 'completed' : 'error'
        if (job.status === 'error') job.error = result.error ? String(result.error.value).slice(0, 1000) : result.complete ? 'Command exited with a nonzero status' : 'Command completion was not confirmed'
        await save()
      })
    } catch (error) {
      await serial(async () => { job.status = controller.signal.aborted ? 'cancelled' : 'error'; job.error = error.status ? error.message : 'OpenSandbox execution failed; check the local server and Docker engine.'; await save() })
    } finally {
      clearTimeout(timer)
      if (controller.signal.aborted && !done(job)) job.status = 'cancelled'
      if (sandbox) {
        try { await sandbox.kill() } catch { job.cleanupError = 'Sandbox cleanup is unconfirmed; its server TTL remains active.' }
        try { await sandbox.close() } catch { job.cleanupError = 'Sandbox client cleanup failed; check the local server.' }
      }
      if (job.status !== 'awaiting_approval') await serial(async () => { job.finishedAt = new Date().toISOString(); job.durationMs = job.startedAt ? Date.now() - Date.parse(job.startedAt) : 0; await save() })
    }
  }
  const runner = {
    async status() { let configured = false; try { await config(); configured = true } catch {} return { configured, runtime: 'OpenSandbox / Docker', isolation: 'ephemeral container; no host mounts', jobs: jobs.map(summary) } },
    async health() {
      const settings = await config()
      try { const response = await fetch('http://' + settings.domain + '/sandboxes', { headers: { 'OPEN-SANDBOX-API-KEY': settings.apiKey }, signal: AbortSignal.timeout(4000) }); await response.body?.cancel(); if (!response.ok) throw Error(); return { connected: true } }
      catch { throw problem('SANDBOX_OFFLINE', 'OpenSandbox is offline; start Docker and the local server', 503) }
    },
    run: input => serial(async () => {
      if (closed) throw problem('CLOSED', 'Service is closing', 503)
      const args = sandboxRunInput.parse(input)
      const fingerprint = createHash('sha256').update(JSON.stringify(args)).digest('hex')
      const previous = jobs.find(j => j.task_id === args.task_id && j.request_id === args.request_id)
      if (previous) { if (previous.fingerprint !== fingerprint) throw problem('REQUEST_CONFLICT', 'Request id already describes another execution', 409); return { ...summary(previous), replayed: true } }
      if (['completed', 'error'].includes(files.getTask(args.task_id).status) || isCancelled(args.task_id)) throw problem('TASK_CLOSED', 'Task is closed', 409)
      await config()
      if (jobs.length >= 200 || jobs.filter(j => !done(j)).length >= 16) throw problem('SANDBOX_LIMIT', 'Execution queue is full', 409)
      const job = { ...args, id: randomUUID(), fingerprint, output: '', createdAt: new Date().toISOString(), status: 'awaiting_approval' }
      if (allowed(job)) { if (active.size >= 2) throw problem('SANDBOX_BUSY', 'Two executions are active; collect their results first', 409); job.status = 'queued' }
      jobs.push(job); await save()
      if (job.status === 'queued') launch(job)
      return summary(job)
    }),
    get(input) { const args = sandboxReadInput.parse(input), job = find(args.execution_id, args.task_id), end = args.offset + args.limit; return { ...summary(job), command: job.command, output: job.output.slice(args.offset, end), offset: args.offset, next_offset: end < job.output.length ? end : null, truncated: Boolean(job.truncated), exitCode: job.exitCode } },
    decide: (id, decision) => serial(async () => {
      if (closed) throw problem('CLOSED', 'Service is closing', 503)
      const job = find(id)
      if (job.status !== 'awaiting_approval') throw problem('EXECUTION_CLOSED', 'Execution is no longer awaiting approval', 409)
      if (!['approve', 'reject'].includes(decision)) throw problem('INVALID_DECISION', 'Choose approve or reject')
      if (decision === 'approve') { if (isCancelled(job.task_id)) throw problem('TASK_CLOSED', 'Task is cancelled', 409); if (active.size >= 2) throw problem('SANDBOX_BUSY', 'Two executions are active', 409); job.status = 'queued' }
      else job.status = 'rejected'
      await save(); if (decision === 'approve') launch(job, true)
      return summary(job)
    }),
    cancel: (id, taskId) => serial(async () => { const job = find(id, taskId); if (!done(job)) { const running = active.get(id); job.status = running ? 'cancel_requested' : 'cancelled'; running?.controller.abort(); await save() } return summary(job) }),
    async cancelParent(taskId) { for (const job of jobs.filter(j => j.task_id === taskId && !done(j))) await runner.cancel(job.id, taskId) },
    assertComplete(taskId) { if (jobs.some(j => j.task_id === taskId && !done(j))) throw problem('SANDBOX_PENDING', 'Collect or cancel outstanding sandbox executions first', 409) },
    async close() { closed = true; for (const value of active.values()) value.controller.abort(); await Promise.all([...active.values()].map(a => a.work)); await sequence }
  }
  return runner
}
