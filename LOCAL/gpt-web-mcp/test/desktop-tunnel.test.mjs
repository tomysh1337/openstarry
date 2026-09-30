import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DesktopTunnel } from '../desktop-tunnel.mjs'
import { startBridge } from '../server.mjs'
import { setTimeout as delay } from 'node:timers/promises'

async function fixture(t) {
  const stateDir = await mkdtemp(join(tmpdir(), 'openstarry-tunnel-controls-')), children = []
  const manager = new DesktopTunnel({ stateDir, cloudflared: 'fixture-cloudflared', createChild: (_file, args, options) => {
    const child = new EventEmitter()
    child.connected = true; child.exitCode = null; child.requests = []
    child.send = (value, callback) => {
      child.requests.push(value)
      if (value.type === 'shutdown') queueMicrotask(() => { child.exitCode = 0; child.connected = false; child.emit('exit', 0) })
      callback?.()
    }
    child.kill = () => { child.exitCode = 1; child.connected = false; child.emit('exit', 1) }
    children.push({ child, args, options }); return child
  } })
  t.after(async () => { await manager.stop(); await rm(stateDir, { recursive: true, force: true }) })
  return { manager, children, write: value => writeFile(join(stateDir, 'public-connection.json'), JSON.stringify(value)) }
}

test('status is read-only; concurrent start reuses its one hidden child and connected URL', async t => {
  const f = await fixture(t)
  await f.write({ status: 'connected', publicOrigin: 'https://stale.example', mcpUrl: 'private-old-address' })
  assert.equal((await f.manager.status()).status, 'stopped')
  assert.equal(f.children.length, 0)
  await Promise.all([f.manager.start(), f.manager.start()])
  assert.equal(f.children.length, 1)
  assert.equal(f.children[0].options.windowsHide, true)
  assert.ok(f.children[0].args.includes('0'))
  await f.write({ status: 'connected', publicOrigin: 'https://fixture.example', mcpUrl: 'private-address' })
  const current = await f.manager.start()
  assert.equal(current.status, 'connected')
  assert.equal(current.origin, 'https://fixture.example')
  assert.ok(!JSON.stringify(current).includes('private-address'))
  assert.equal(f.children.length, 1)
})

test('stop waits for child exit, clears stale origin and allows a later restart', async t => {
  const f = await fixture(t)
  await f.manager.start()
  await f.write({ status: 'connected', publicOrigin: 'https://fixture.example' })
  const stopped = await f.manager.stop()
  assert.equal(stopped.status, 'stopped'); assert.equal(stopped.running, false); assert.equal(stopped.origin, undefined)
  assert.deepEqual(f.children[0].child.requests, [{ type: 'shutdown' }])
  await f.manager.stop()
  assert.equal((await f.manager.start()).status, 'starting')
  assert.equal(f.children.length, 2)
})

test('spawn and early tunnel failures are visible, redacted and retryable', async t => {
  const f = await fixture(t)
  await f.manager.start()
  f.children[0].child.emit('message', { type: 'tunnel-error', error: 'failed /mcp/private-capability' })
  const error = await f.manager.status()
  assert.equal(error.status, 'error')
  assert.ok(!error.message.includes('private-capability'))
  f.children[0].child.kill()
  assert.equal((await f.manager.status()).running, false)
  assert.equal((await f.manager.start()).status, 'starting')
  f.children[1].child.emit('error', Error('spawn ENOENT'))
  assert.match((await f.manager.status()).message, /ENOENT/)
})

test('real tunnel helper reports a missing executable and exits', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'openstarry-tunnel-process-')), stateDir = join(dir, 'control')
  let bridge, manager
  t.after(async () => { await manager?.stop(); await bridge?.close(); await rm(dir, { recursive: true, force: true }) })
  await mkdir(join(dir, 'workspace'))
  bridge = await startBridge({ workspace: join(dir, 'workspace'), stateDir, port: 0 })
  await writeFile(join(stateDir, 'connection.json'), JSON.stringify({ origin: bridge.origin, mcpUrl: bridge.mcpUrl }))
  manager = new DesktopTunnel({ stateDir, cloudflared: join(dir, 'missing-cloudflared.exe') })
  await manager.start()
  let status
  for (let i = 0; i < 200; i++) {
    status = await manager.status()
    if (status.status === 'error' && !status.running) break
    await delay(25)
  }
  assert.equal(status.status, 'error'); assert.equal(status.running, false)
  assert.match(status.message, /ENOENT/)
  assert.ok(!JSON.stringify(status).includes(bridge.mcpUrl))
})
