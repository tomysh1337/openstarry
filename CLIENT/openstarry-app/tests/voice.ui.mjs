import { spawn } from 'node:child_process'
import electron from 'electron'
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(electron, ['tests/voice.electron.mjs'], {
  env,
  windowsHide: true,
  stdio: 'inherit'
})
const timeout = setTimeout(() => {
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
