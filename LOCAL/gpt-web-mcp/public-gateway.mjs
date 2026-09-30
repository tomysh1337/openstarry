import { createServer, request } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { pipeline } from 'node:stream/promises'

const equal = (a, b) => { const l = Buffer.from(a || ''), r = Buffer.from(b); return l.length === r.length && timingSafeEqual(l, r) }
const json = (res, status, error) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify({ error })) }

// Separate listener: neither /admin nor its credentials ever enter this proxy.
export async function startPublicGateway({ mcpUrl, port = 49323 }) {
  const upstream = new URL(mcpUrl)
  if (upstream.protocol !== 'http:' || upstream.hostname !== '127.0.0.1' || !/^\/mcp\/[\w-]{43}$/.test(upstream.pathname) || upstream.search || upstream.hash || upstream.username || upstream.password) throw Error('Use the local bridge capability URL')
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('Invalid gateway port')
  let publicOrigin, origin, closing, active = 0
  const http = createServer((req, res) => { void handle(req, res).catch(() => { if (!res.headersSent) json(res, 502, 'Local MCP upstream unavailable'); else res.destroy() }) })
  http.requestTimeout = 20000; http.headersTimeout = 10000; http.maxConnections = 64
  async function handle(req, res) {
    if (req.headers.host !== new URL(origin).host) return json(res, 403, 'Invalid origin Host')
    if (req.headers.origin && req.headers.origin !== publicOrigin) return json(res, 403, 'Origin is not allowed')
    const health = req.url === '/health' && req.method === 'GET'
    if (!health && !equal(req.url, upstream.pathname)) return json(res, 404, 'Not found')
    if (!health && !['POST', 'GET', 'DELETE'].includes(req.method)) return json(res, 405, 'Method not allowed')
    if (active >= 16) return json(res, 429, 'Too many active requests')
    active++
    try {
      const chunks = []; let size = 0
      if (req.method === 'POST') {
        if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return json(res, 415, 'Use application/json')
        for await (const chunk of req) { size += chunk.length; if (size > 256 * 1024) return json(res, 413, 'Body exceeds 256 KiB'); chunks.push(chunk) }
      }
      const headers = { host: upstream.host }
      for (const name of ['content-type', 'accept', 'mcp-protocol-version', 'mcp-session-id', 'last-event-id']) if (req.headers[name]) headers[name] = req.headers[name]
      if (req.method === 'POST') headers['content-length'] = size
      const controller = new AbortController()
      const disconnect = () => { if (!res.writableEnded) controller.abort() }
      res.once('close', disconnect)
      try {
        const response = await new Promise((resolve, reject) => {
          const outgoing = request({ hostname: upstream.hostname, port: upstream.port, path: health ? '/health' : upstream.pathname, method: req.method, headers, signal: controller.signal }, resolve)
          outgoing.setTimeout(30000, () => outgoing.destroy(Error('Upstream timeout')))
          outgoing.once('error', reject); outgoing.end(Buffer.concat(chunks))
        })
        const responseHeaders = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
        for (const name of ['content-type', 'mcp-session-id', 'mcp-protocol-version', 'retry-after', 'allow']) if (response.headers[name]) responseHeaders[name] = response.headers[name]
        res.writeHead(response.statusCode, responseHeaders)
        await pipeline(response, res)
      } finally { res.off('close', disconnect) }
    } finally { active-- }
  }
  await new Promise((resolve, reject) => { http.once('error', reject); http.listen(port, '127.0.0.1', resolve) })
  origin = 'http://127.0.0.1:' + http.address().port
  return {
    origin,
    setPublicOrigin(value) { const url = new URL(value); if (url.protocol !== 'https:' || url.origin !== value) throw Error('Use an HTTPS origin'); publicOrigin = value },
    close: () => closing ??= new Promise(resolve => http.close(resolve))
  }
}
