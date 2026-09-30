// Consume each log line once; old success lines must never mask a new failure.
export class TunnelLogState {
  publicOrigin = null
  status = 'starting'
  reason = ''
  partial = ''
  active = new Set()

  push(text) {
    this.partial += text
    const lines = this.partial.split(/\r?\n/)
    this.partial = lines.pop().slice(-8192)
    const changes = []
    for (const line of lines) {
      const previous = JSON.stringify([this.publicOrigin, this.status, this.reason])
      const url = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)
      if (url && !this.publicOrigin) { this.publicOrigin = url[0]; this.status = 'connecting' }
      const index = line.match(/\bconnIndex=(\d+)/)?.[1] ?? '0'
      if (/Registered tunnel connection/.test(line)) {
        this.active.add(index); this.status = 'connected'; this.reason = ''
      } else if (/Tunnel not found|tunnel has been deleted/i.test(line)) {
        this.active.clear(); this.status = 'expired'
        this.reason = 'Cloudflare no longer recognizes this temporary tunnel; create a new URL'
      } else if (/Connection terminated|Serve tunnel error|Unable to establish connection|TLS handshake with edge error|Retrying connection/i.test(line)) {
        this.active.delete(index)
        if (!this.active.size && this.status !== 'expired') {
          this.status = 'reconnecting'; this.reason = 'Cloudflare edge connection interrupted'
        }
      }
      if (JSON.stringify([this.publicOrigin, this.status, this.reason]) !== previous) changes.push({ publicOrigin: this.publicOrigin, status: this.status, reason: this.reason })
    }
    return changes
  }
}
