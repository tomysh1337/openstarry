import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const port = Number(process.env.OPENSTARRY_CDP_PORT || 9229)
const screenshotPath = resolve(process.argv[2] || 'dist/smoke/openstarry.png')
const routes = ['/assistPage', '/flowEditPage', '/dataPage', '/taskPage', '/settingPage']
const wait = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))

const discoveryDeadline = Date.now() + 30_000
let page
do {
  try {
    const pages = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json())
    page = pages.find((entry) => entry.type === 'page' && entry.title === 'OpenStarry NextGen')
  } catch {}
  if (!page) await wait(500)
} while (!page && Date.now() < discoveryDeadline)

if (!page?.webSocketDebuggerUrl) throw new Error('OpenStarry DevTools page was not found')

const socket = new WebSocket(page.webSocketDebuggerUrl)
const pending = new Map()
let sequence = 0

await new Promise((resolvePromise, reject) => {
  socket.addEventListener('open', resolvePromise, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (!message.id) return
  const request = pending.get(message.id)
  if (!request) return
  pending.delete(message.id)
  if (message.error) request.reject(new Error(message.error.message))
  else request.resolve(message.result)
})

function call(method, params = {}) {
  const id = ++sequence
  return new Promise((resolvePromise, reject) => {
    pending.set(id, { resolve: resolvePromise, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(expression) {
  const result = await call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true
  })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
  }
  return result.result.value
}

await call('Runtime.enable')
await call('Page.enable')

const deadline = Date.now() + 90_000
let runtimeStatus
do {
  runtimeStatus = await evaluate('window.api.system.runtimeStatus()')
  if (runtimeStatus?.phase === 'ready') break
  await wait(1_000)
} while (Date.now() < deadline)

if (runtimeStatus?.phase !== 'ready') {
  throw new Error(`Desktop runtime did not become ready: ${JSON.stringify(runtimeStatus)}`)
}

const computerControl = await evaluate(`window.api.system.computerAction('list_apps', {}).then((result) => ({
  available: true,
  resultType: Array.isArray(result) ? 'array' : typeof result,
  itemCount: Array.isArray(result) ? result.length : null,
  keys: result && !Array.isArray(result) && typeof result === 'object' ? Object.keys(result).slice(0, 10) : []
}))`)

const results = []
for (const route of routes) {
  await evaluate(`location.hash = ${JSON.stringify(route)}`)
  await wait(1_000)
  const state = await evaluate(`({
    route: location.hash,
    title: document.title,
    startupOverlay: Boolean(document.querySelector('.startup-overlay')),
    text: document.body.innerText.trim().slice(0, 500),
    elementCount: document.body.querySelectorAll('*').length
  })`)
  if (state.startupOverlay) throw new Error(`Startup overlay is still visible on ${route}`)
  if (state.text.length < 10 || state.elementCount < 10) throw new Error(`Page is blank on ${route}`)
  results.push(state)
}

const screenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
await mkdir(dirname(screenshotPath), { recursive: true })
await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'))

console.log(JSON.stringify({ runtimeStatus, computerControl, routes: results, screenshotPath }, null, 2))
socket.close()
