import test from 'node:test'
import assert from 'node:assert/strict'
import { TunnelLogState } from '../tunnel-state.mjs'

const url = 'https://test-demo.trycloudflare.com'
test('connected becomes reconnecting after edge failure, then recovers on new registration', () => {
  const state = new TunnelLogState()
  state.push(url + '\nINF Registered tunnel connection connIndex=0\n')
  assert.equal(state.status, 'connected')
  assert.equal(state.push('ERR Serve tunnel error error="TLS handshake with edge error: EOF" connIndex=0\n').at(-1).status, 'reconnecting')
  state.push('INF unrelated log line\n')
  assert.equal(state.status, 'reconnecting')
  state.push('INF Registered tunnel connection connIndex=0\n')
  assert.equal(state.status, 'connected')
})

test('chunk boundaries are handled without replaying historical connection lines', () => {
  const state = new TunnelLogState()
  state.push('https://test-demo.trycloud')
  assert.equal(state.publicOrigin, null)
  state.push('flare.com\nINF Registered tunnel connec')
  assert.equal(state.publicOrigin, url)
  assert.equal(state.status, 'connecting')
  state.push('tion connIndex=0\nERR Connection terminated connIndex=0\n')
  assert.equal(state.status, 'reconnecting')
})

test('a removed Quick Tunnel stays expired during connection retries', () => {
  const state = new TunnelLogState()
  state.push(url + '\nINF Registered tunnel connection connIndex=0\n')
  state.push('ERR Register tunnel error error="Unauthorized: Tunnel not found" connIndex=0\n')
  assert.equal(state.status, 'expired')
  state.push('INF Retrying connection in up to 1m4s connIndex=0\nERR TLS handshake with edge error: EOF connIndex=0\n')
  assert.equal(state.status, 'expired')
  assert.equal(state.reason, 'Cloudflare no longer recognizes this temporary tunnel; create a new URL')
})
