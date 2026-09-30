// Launches the actual homepage for user-driven checks, without a UI automation client.
import { spawn } from 'node:child_process'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = resolve(appRoot, '../../tmp/home-web-manual-20260925')
const main = resolve(artifacts, 'main.cjs')
const executable = resolve(appRoot, 'node_modules/electron/dist/electron.exe')
const runtime = resolve(appRoot, 'vendor/runtime-tools/node.exe')
const args = process.argv.slice(2)
if (args.length > 1 || (args.length === 1 && args[0] !== '--prepare')) {
  throw Error('Usage: node tests/homeWeb.manual.mjs [--prepare]')
}
for (const file of [
  executable,
  runtime,
  resolve(appRoot, 'out/renderer/index.html'),
  resolve(appRoot, 'out/preload/index.js'),
  resolve(appRoot, '../../LOCAL/gpt-web-mcp/desktop-worker.mjs')
]) {
  await access(file)
}
await mkdir(artifacts, { recursive: true })
await build({
  absWorkingDir: appRoot,
  entryPoints: ['tests/homeWeb.electron.mjs'],
  outfile: main,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  logLevel: 'silent'
})

if (args.includes('--prepare')) {
  const launcher = resolve(artifacts, 'start-manual.cmd')
  // The launcher lives two levels below the repository root; keep it relocatable.
  await writeFile(
    launcher,
    '@echo off\r\n"%~dp0..\\..\\CLIENT\\openstarry-app\\vendor\\runtime-tools\\node.exe" "%~dp0..\\..\\CLIENT\\openstarry-app\\tests\\homeWeb.manual.mjs"\r\nif errorlevel 1 pause\r\n',
    'ascii'
  )
  console.log(JSON.stringify({ prepared: true, launched: false, launcher }))
} else {
  const child = spawn(executable, [main], {
    cwd: appRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      OPENSTARRY_WEB_ACCEPTANCE: 'manual',
      OPENSTARRY_WEB_TEST_PROFILE: resolve(artifacts, 'profile')
    }
  })
  await new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      process.exitCode = signal ? 1 : (code ?? 1)
      resolveExit()
    })
  })
}
