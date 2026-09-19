import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { IdeWorkspace } from '../src/main/app/ideWorkspace.mjs'
test('desktop project edits detect external changes and enforce project boundaries', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openstarry-ide-test-')), ide = new IdeWorkspace()
  try {
    await fs.writeFile(path.join(root, 'main.js'), 'old')
    await assert.rejects(ide.readProject(root), /重新选择/); await ide.authorize(root)
    assert.equal((await ide.readProject(root)).files['main.js'], 'old')
    await ide.write({ root, path: 'main.js', content: 'new', expected: 'old' })
    await assert.rejects(ide.write({ root, path: 'main.js', content: 'stale', expected: 'old' }), /已经改变/)
    await assert.rejects(ide.write({ root, path: '../outside.js', content: 'x', expected: null }), /项目目录/)
    await ide.write({ root, path: 'src/new.js', content: 'hello', expected: null })
    assert.equal(await fs.readFile(path.join(root, 'src/new.js'), 'utf8'), 'hello')
    await assert.rejects(ide.write({ root, path: 'src/new.js', content: 'overwrite', expected: null }), /已经改变/)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
test('commands run in the selected project, capture output, and stop process trees', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openstarry-ide-test-')), ide = new IdeWorkspace()
  try {
    await ide.authorize(root); await fs.writeFile(path.join(root, 'run.cjs'), "console.log('RUN_OK')")
    const first = await ide.run({ root, command: 'node run.cjs' }); const result = await first.done
    assert.equal(result.exitCode, 0); assert.match(result.output, /RUN_OK/)
    await fs.writeFile(path.join(root, 'wait.cjs'), 'setInterval(()=>{},1000)')
    const second = await ide.run({ root, command: 'node wait.cjs' }); ide.stop(second.id)
    const timeout = new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('process still running')), 15000); timer.unref() })
    await Promise.race([second.done, timeout]); assert.equal(ide.jobs.size, 0)
  } finally { ide.stopAll(); await fs.rm(root, { recursive: true, force: true }) }
})
