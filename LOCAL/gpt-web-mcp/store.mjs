import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, realpath, lstat, open, unlink, readdir } from 'node:fs/promises'
import { resolve, relative, join, dirname, isAbsolute } from 'node:path'
import { createDiskAccess } from './disk-access.mjs'

const limit = 128 * 1024
const version = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex')
const inside = (root, target) => { const rel = relative(root, target); return !rel.startsWith('..') && !isAbsolute(rel) }
export function problem(code, message, status = 400) { return Object.assign(Error(code + ': ' + message), { status }) }
async function jsonFile(file, value) {
  const temp = file + '.' + randomUUID() + '.tmp'
  try { await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' }); await rename(temp, file) }
  finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error }) }
}

export async function openStore({ workspace, stateDir, fileScope = 'workspace', newFilePolicy = 'review', protectedPaths = [], getPolicy = () => ({ newFilePolicy, safetyMode: newFilePolicy === 'direct' ? 'auto' : 'ask', existingFileReviewRequired: true }) }) {
  if (!['workspace', 'all-disks'].includes(fileScope)) throw Error('Invalid file access scope')
  if (!['review', 'direct'].includes(newFilePolicy)) throw Error('Invalid new file policy')
  const root = await realpath(resolve(workspace))
  if (!(await lstat(root)).isDirectory()) throw Error('Workspace must be a directory')
  await mkdir(resolve(stateDir), { recursive: true, mode: 0o700 })
  const privateRoot = await realpath(resolve(stateDir))
  if (inside(root, privateRoot)) throw Error('Private state must be outside the project workspace')
  const disk = fileScope === 'all-disks' ? createDiskAccess({ protectedPaths: [privateRoot, ...protectedPaths] }) : null
  const statePath = join(privateRoot, 'state.json'), keysPath = join(privateRoot, 'keys.json')
  let data, keys
  try { data = JSON.parse(await readFile(statePath, 'utf8')) }
  catch (error) { if (error.code !== 'ENOENT') throw error; data = { version: 1, workspace: root, tasks: [], proposals: [] } }
  if (data.version !== 1 || data.workspace !== root || !Array.isArray(data.tasks) || !Array.isArray(data.proposals)) throw Error('State belongs to another workspace or has an invalid format')
  data.creations ??= []
  if (!Array.isArray(data.creations)) throw Error('Invalid file creation receipts')
  for (const receipt of data.creations) if (receipt.status === 'creating') receipt.status = 'recovery_required'
  try { keys = JSON.parse(await readFile(keysPath, 'utf8')) }
  catch (error) { if (error.code !== 'ENOENT') throw error; keys = { mcp: randomBytes(32).toString('base64url'), admin: randomBytes(32).toString('base64url') }; await jsonFile(keysPath, keys) }
  if (![keys.mcp, keys.admin].every(key => typeof key === 'string' && /^[\w-]{43}$/.test(key))) throw Error('Invalid private token file')
  for (const proposal of data.proposals) if (proposal.status === 'applying') proposal.status = 'recovery_required'
  await jsonFile(statePath, data)
  let sequence = Promise.resolve()
  const serial = fn => { const next = sequence.then(fn); sequence = next.catch(() => {}); return next }
  const save = () => jsonFile(statePath, data)
  const task = id => { const found = data.tasks.find(t => t.id === id); if (!found) throw problem('NOT_FOUND', 'Task not found', 404); return found }
  const proposal = id => { const found = data.proposals.find(p => p.id === id); if (!found) throw problem('NOT_FOUND', 'Proposal not found', 404); return found }
  const requestId = value => { if (typeof value !== 'string' || !value.trim() || value.length > 220) throw problem('INVALID_REQUEST', 'Request id is required') }
  const textContent = value => { if (typeof value !== 'string' || Buffer.byteLength(value) > limit || value.includes('\0')) throw problem('FILE_LIMIT', 'File content must be UTF-8 text up to 128 KiB') }

  function validatePath(path) {
    if (disk && typeof path === 'string' && isAbsolute(path)) return disk.validatePath(path).parts
    if (typeof path !== 'string' || path.length > 220 || !path || /[\\:\x00-\x1f]/.test(path) || isAbsolute(path)) throw problem('PATH_DENIED', 'Use a project-relative file path')
    const parts = path.split('/')
    if (parts.some(part => !part || part.startsWith('.') || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || /\.(pem|key|pfx|p12)$/i.test(part))) throw problem('PATH_DENIED', 'Hidden, private and special paths are excluded from this prototype')
    return parts
  }
  async function target(path) {
    if (disk && typeof path === 'string' && isAbsolute(path)) return disk.target(path)
    const parts = validatePath(path)
    if (await realpath(root) !== root || (await lstat(root)).isSymbolicLink()) throw problem('PATH_DENIED', 'Workspace root changed')
    let current = root
    for (let i = 0; i < parts.length; i++) {
      current = join(current, parts[i])
      try {
        const info = await lstat(current)
        if (info.isSymbolicLink() || (info.isFile() && info.nlink > 1)) throw problem('PATH_DENIED', 'Linked files are excluded')
        if (i < parts.length - 1 && !info.isDirectory()) throw problem('PATH_DENIED', 'Parent is not a directory')
        if (!inside(root, await realpath(current))) throw problem('PATH_DENIED', 'Path leaves the workspace')
      } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    return current
  }
  async function snapshot(path) {
    const absolute = await target(path)
    try {
      const file = await open(absolute, 'r')
      try {
        const info = await file.stat()
        if (!info.isFile() || info.size > limit || info.nlink > 1) throw problem('FILE_LIMIT', 'Only unlinked UTF-8 files up to 128 KiB are supported')
        const bytes = await file.readFile()
        if (bytes.length > limit) throw problem('FILE_LIMIT', 'File exceeds 128 KiB')
        const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
        if (content.includes('\0')) throw problem('FILE_LIMIT', 'Binary files are excluded')
        return { path, content, version: version(bytes) }
      } finally { await file.close() }
    } catch (error) { if (error.code === 'ENOENT') return { path, content: null, version: null }; throw error }
  }

  const store = {
    root, privateRoot, keys,
    status: () => ({ name: 'OpenStarry GPT Web MCP', version: '0.3.0', fileScope, reviewRequired: getPolicy().existingFileReviewRequired, ...getPolicy(), browserConnected: false, tasks: data.tasks.length, pendingProposals: data.proposals.filter(p => p.status === 'pending').length }),
    listTasks: () => structuredClone({ tasks: data.tasks }),
    getTask: id => structuredClone(task(id)),
    listProposals: () => structuredClone({ proposals: data.proposals }),
    async listFiles(options) {
      if (disk) return disk.list(options)
      const files = [], queue = ['']; let entries = 0
      while (queue.length) {
        const dir = queue.shift()
        const absolute = dir ? await target(dir) : root
        for (const item of await readdir(absolute, { withFileTypes: true })) {
          if (++entries > 4096) throw problem('FILE_LIMIT', 'Directory inventory exceeds 4096 entries')
          const path = dir ? dir + '/' + item.name : item.name
          try { validatePath(path) } catch { continue }
          if (item.isSymbolicLink() || ['node_modules', 'dist', 'build'].includes(item.name)) continue
          if (item.isDirectory() && path.split('/').length < 12) queue.push(path)
          else if (item.isFile()) files.push(path)
        }
      }
      return { files }
    },
    readFile: ({ task_id, path }) => { if (task_id || !disk) task(task_id); return snapshot(path) },
    submitTask: (prompt, { source = 'local', requestId: request } = {}) => serial(async () => {
      if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 16000) throw problem('INVALID_TASK', 'Task must be 1–16000 characters')
      if (!['local', 'connector', 'subagent'].includes(source)) throw problem('INVALID_TASK', 'Unknown task source')
      if (source !== 'local') {
        requestId(request)
        const existing = data.tasks.find(t => t.source === source && t.requestId === request)
        if (existing) {
          if (existing.prompt !== prompt.trim()) throw problem('REQUEST_CONFLICT', 'This task request id already has different content', 409)
          return structuredClone(existing)
        }
      }
      if (data.tasks.length >= 200) throw problem('QUEUE_FULL', 'Prototype task limit reached', 409)
      const value = { id: randomUUID(), prompt: prompt.trim(), source, ...(request ? { requestId: request } : {}), status: 'queued', result: '', createdAt: new Date().toISOString() }
      data.tasks.push(value); await save(); return structuredClone(value)
    }),
    createFile: args => serial(async () => {
      if (getPolicy().newFilePolicy !== 'direct') throw problem('REVIEW_REQUIRED', 'New files require local review. Use create_task then propose_file with expected_version null', 409)
      validatePath(args.path); textContent(args.content); requestId(args.request_id)
      const afterVersion = version(Buffer.from(args.content)), taskId = args.task_id || null
      const existing = data.creations.find(value => value.requestId === args.request_id)
      if (existing) {
        if (existing.path !== args.path || existing.version !== afterVersion || existing.taskId !== taskId) throw problem('REQUEST_CONFLICT', 'This creation request id already has different content', 409)
        if (existing.status === 'created') return { ...structuredClone(existing), replayed: true }
        if (existing.status === 'exists') throw problem('FILE_EXISTS', 'Path already exists. Use read_file, create_task and propose_file for reviewed changes', 409)
        throw problem('RECOVERY_REQUIRED', 'An earlier create attempt was interrupted or failed. Inspect the path with read_file before using a new request id; existing files still require review', 409)
      }
      if (taskId && task(taskId).status === 'completed') throw problem('TASK_CLOSED', 'Task is already complete', 409)
      if (data.creations.length >= 1000) throw problem('QUEUE_FULL', 'File creation receipt limit reached', 409)
      const absolute = await target(args.path)
      const receipt = { id: randomUUID(), requestId: args.request_id, taskId, path: args.path, version: afterVersion, status: 'creating', requestedAt: new Date().toISOString() }
      data.creations.push(receipt)
      await save()
      let opened = false
      try {
        await mkdir(dirname(absolute), { recursive: true })
        await target(args.path)
        // Exclusive open is the final check, including files created after validation.
        const file = await open(absolute, 'wx'); opened = true
        try { await file.writeFile(args.content); await file.sync() } finally { await file.close() }
        receipt.status = 'created'; receipt.createdAt = new Date().toISOString(); await save()
        return { ...structuredClone(receipt), replayed: false }
      } catch (error) {
        receipt.status = !opened && error.code === 'EEXIST' ? 'exists' : 'recovery_required'
        await save()
        if (receipt.status === 'exists') throw problem('FILE_EXISTS', 'Path already exists. Use read_file, create_task and propose_file for reviewed changes', 409)
        throw error
      }
    }),
    propose: (args, { automatic = false } = {}) => serial(async () => {
      const t = task(args.task_id)
      validatePath(args.path)
      if (typeof args.content !== 'string' || Buffer.byteLength(args.content) > limit || args.content.includes('\0')) throw problem('FILE_LIMIT', 'Proposal must be UTF-8 text up to 128 KiB')
      if (typeof args.request_id !== 'string' || !args.request_id || args.request_id.length > 220) throw problem('INVALID_REQUEST', 'Request id is required')
      const existing = data.proposals.find(p => p.taskId === t.id && p.requestId === args.request_id)
      if (existing) {
        if (existing.path !== args.path || existing.after !== args.content || existing.beforeVersion !== args.expected_version) throw problem('REQUEST_CONFLICT', 'This request id already has different content', 409)
        return structuredClone(existing)
      }
      if (t.status === 'completed') throw problem('TASK_CLOSED', 'Task is already complete', 409)
      const before = await snapshot(args.path)
      if (args.expected_version !== before.version) throw problem('VERSION_CONFLICT', 'Read the current file before proposing an edit', 409)
      if (data.proposals.length >= 200) throw problem('QUEUE_FULL', 'Prototype proposal limit reached', 409)
      const value = { id: randomUUID(), taskId: t.id, requestId: args.request_id, path: args.path, before: before.content, beforeVersion: before.version, after: args.content, afterVersion: version(Buffer.from(args.content)), status: 'pending', createdAt: new Date().toISOString(), ...(automatic ? { automatic: true } : {}) }
      data.proposals.push(value); t.status = 'awaiting_review'; await save(); return structuredClone(value)
    }),
    decide: (id, decision, { automatic = false } = {}) => serial(async () => {
      const p = proposal(id)
      if (automatic) {
        if (p.status !== 'pending') return structuredClone(p)
        const mode = getPolicy().safetyMode
        if (!p.automatic || !(mode === 'full' || (mode === 'auto' && p.beforeVersion === null))) return structuredClone(p)
      }
      if (p.status !== 'pending') throw problem('PROPOSAL_CLOSED', 'Proposal has already been reviewed or needs recovery', 409)
      if (decision === 'reject') { p.status = 'rejected'; await save(); return structuredClone(p) }
      if (decision !== 'accept') throw problem('INVALID_DECISION', 'Choose accept or reject')
      const before = await snapshot(p.path)
      if (before.version !== p.beforeVersion) throw problem('VERSION_CONFLICT', 'File changed since this proposal; saved file was left unchanged', 409)
      const absolute = await target(p.path)
      await mkdir(dirname(absolute), { recursive: true })
      await target(p.path)
      const backup = join(privateRoot, 'backups')
      await mkdir(backup, { recursive: true, mode: 0o700 })
      await jsonFile(join(backup, p.id + '.json'), { path: p.path, before: p.before, beforeVersion: p.beforeVersion })
      const staged = absolute + '.' + randomUUID() + '.tmp'
      try {
        await writeFile(staged, p.after, { flag: 'wx' })
        if ((await snapshot(p.path)).version !== p.beforeVersion) throw problem('VERSION_CONFLICT', 'File changed while staging', 409)
        p.status = 'applying'; await save()
        if (before.version === null) {
          // Exclusive creation never overwrites a newly created user file.
          const file = await open(absolute, 'wx')
          try { await file.writeFile(p.after) } finally { await file.close() }
        } else await rename(staged, absolute)
        p.status = 'accepted'; p.reviewedAt = new Date().toISOString(); await save()
        return structuredClone(p)
      } catch (error) {
        if (p.status === 'applying') { p.status = 'recovery_required'; await save() }
        throw error
      } finally { await unlink(staged).catch(error => { if (error.code !== 'ENOENT') throw error }) }
    }),
    report: args => serial(async () => {
      const t = task(args.task_id)
      if (args.status === 'completed' && data.proposals.some(p => p.taskId === t.id && ['pending', 'applying', 'recovery_required'].includes(p.status))) throw problem('REVIEW_PENDING', 'Wait for local review before reporting completion', 409)
      t.status = args.status; t.result = args.text; await save(); return structuredClone(t)
    }),
    flush: () => sequence
  }
  store.writeFile = async args => {
    const mode = getPolicy().safetyMode
    const automatic = mode === 'full' || (mode === 'auto' && args.expected_version === null)
    const proposal = await store.propose(args, { automatic })
    return store.decide(proposal.id, 'accept', { automatic: true })
  }
  return store
}
