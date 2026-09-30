import { copyFile, mkdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const execute = promisify(execFile)
const target = resolve('vendor/runtime-tools'); await mkdir(target, { recursive: true })
const candidates = [join(process.env.ProgramFiles || 'C:/Program Files', 'nodejs', 'node.exe'), process.execPath]
let runtime
for (const candidate of candidates) {
  try { const { stdout } = await execute(candidate, ['--version'], { windowsHide: true }); if (Number(/^v(\d+)/.exec(stdout)?.[1]) >= 24) { runtime = candidate; break } } catch {}
}
if (!runtime) throw Error('Packaging the webpage service requires Node >=24')
await copyFile(runtime, join(target, 'node.exe'))
const cloudflared = 'C:/Program Files (x86)/cloudflared/cloudflared.exe'
if (!(await stat(cloudflared)).isFile()) throw Error('Packaging the connector tunnel requires cloudflared')
await copyFile(cloudflared, join(target, 'cloudflared.exe'))
console.log('Prepared Node >=24 and cloudflared runtime resources; private profiles and task state are excluded.')
