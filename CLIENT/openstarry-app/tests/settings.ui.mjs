import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import electron from 'electron'

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(electron, ['tests/settings.electron.mjs'], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  env,
  windowsHide: true,
  stdio: 'inherit'
})
const timeout = setTimeout(() => {
  console.error('Settings UI test timed out')
  child.kill()
  process.exitCode = 1
}, 60000)
child.on('error', (error) => {
  clearTimeout(timeout)
  console.error(error)
  process.exitCode = 1
})
child.on('exit', (code) => {
  clearTimeout(timeout)
  process.exitCode = code ?? 1
})
