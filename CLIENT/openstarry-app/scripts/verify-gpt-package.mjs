import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { GptWebService } from '../src/main/app/gptWebService.mjs'
import { IdeWorkspace } from '../src/main/app/ideWorkspace.mjs'

// Resource and real helper-process verification only. No browser, GUI or tunnel is opened.
const require = createRequire(import.meta.url), asar = require('@electron/asar')
const root = path.resolve(process.argv[2] || 'dist/gpt-web-preview-20260924/win-unpacked')
const resources = path.join(root, 'resources'), archive = path.join(resources, 'app.asar')
const entries = asar.listPackage(archive).map(name => name.replaceAll('\\', '/'))
assert.ok(entries.includes('/out/main/index.js')); assert.ok(entries.includes('/out/preload/index.js'))
assert.ok(!entries.some(name => /^\/(?:src|tests|tmp|dist|vendor)\//.test(name)))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
let compared = 0
for (const file of await fs.readdir('out', { recursive: true, withFileTypes: true })) {
  if (!file.isFile()) continue
  const absolute = path.join(file.parentPath, file.name), relative = path.relative(path.resolve('out'), absolute).replaceAll('\\', '/')
  assert.equal(hash(asar.extractFile(archive, path.join('out', relative))), hash(await fs.readFile(absolute)), 'Packaged build differs: ' + relative)
  compared++
}
for (const name of ['node.exe', 'cloudflared.exe']) assert.equal(hash(await fs.readFile(path.join(resources, 'runtime', name))), hash(await fs.readFile(path.join('vendor/runtime-tools', name))))
const packagedService = path.join(resources, 'gpt-web-mcp')
const serviceEntries = await fs.readdir(packagedService, { recursive: true })
assert.ok(!serviceEntries.some(name => /(?:^|[\\/])(?:\.state|browser-profile|state\.json|keys\.json|chat\.sqlite(?:-wal|-shm)?|connection\.json|public-connection\.json|web-adapter-private\.json)(?:[\\/]|$)/.test(name)), 'Private state found in package')
for (const name of ['chat-fixture.mjs', 'cli.mjs', 'verify-public.mjs', 'test']) assert.ok(!serviceEntries.includes(name), 'Fixture or development entry found: ' + name)
for (const name of serviceEntries.filter(name => !/[\\/]/.test(name) && name.endsWith('.mjs'))) {
  assert.equal(hash(await fs.readFile(path.join(packagedService, name))), hash(await fs.readFile(path.resolve('../../LOCAL/gpt-web-mcp', name))), 'Packaged service differs: ' + name)
}

const fixtureDir = await fs.mkdtemp(path.join(tmpdir(), 'openstarry-package-fixture-'))
const service = new GptWebService({ baseDir: fixtureDir, scriptPath: path.join(packagedService, 'desktop-worker.mjs'), nodePaths: [path.join(resources, 'runtime/node.exe')], workspace: new IdeWorkspace() })
try {
  const project = { id: 'package-fixture', files: {} }
  await service.ensure(project)
  const origin = service.current.origin
  const health = await fetch(origin + '/health').then(response => response.json())
  assert.equal(health.version, '0.3.0'); assert.equal(health.webpageAdapter, 'not_started')
  assert.deepEqual((await service.admin('chat/adapters')).adapters, [{ adapterId: 'desktop-web', source: 'chatgpt-web' }])
  const status = await service.status(project)
  assert.equal(status.service, 'ready'); assert.equal(status.browser, 'closed')
  assert.equal(status.adminToken, undefined); assert.equal(status.mcpUrl, undefined)
  await service.stop()
  await assert.rejects(fetch(origin + '/health', { signal: AbortSignal.timeout(2000) }))
  console.log(JSON.stringify({ fixture: true, archiveBuildFilesCompared: compared, packagedServiceFiles: serviceEntries.length, privateStateFiles: 0, packagedNodeAndHelper: 'passed', gracefulShutdown: 'passed', browserOpened: false, tunnelStarted: false }, null, 2))
} finally {
  await service.stop()
  const relative = path.relative(await fs.realpath(tmpdir()), await fs.realpath(fixtureDir))
  assert.ok(!relative.includes(path.sep) && relative.startsWith('openstarry-package-fixture-'))
  await fs.rm(fixtureDir, { recursive: true, force: true })
}
