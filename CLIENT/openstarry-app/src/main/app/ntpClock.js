import dgram from 'dgram'
import os from 'os'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'

const NTP_EPOCH_OFFSET_SECONDS = 2208988800
const SERVERS = ['ntp.aliyun.com', 'time1.cloud.tencent.com', 'time.windows.com']

function queryServer(host, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4')
    const packet = Buffer.alloc(48)
    packet[0] = 0x1b
    const timeout = setTimeout(() => {
      socket.close()
      reject(new Error(`NTP timeout: ${host}`))
    }, timeoutMs)
    socket.once('error', (error) => {
      clearTimeout(timeout)
      socket.close()
      reject(error)
    })
    socket.once('message', (message) => {
      clearTimeout(timeout)
      socket.close()
      if (message.length < 48) return reject(new Error(`Invalid NTP response: ${host}`))
      const seconds = message.readUInt32BE(40) - NTP_EPOCH_OFFSET_SECONDS
      const fraction = message.readUInt32BE(44) / 2 ** 32
      resolve((seconds + fraction) * 1000)
    })
    socket.send(packet, 123, host)
  })
}

export class NtpClock {
  constructor() {
    this.cachePath = join(app.getPath('userData'), 'trusted-time.json')
    this.anchor = this._readAnchor()
  }

  _readAnchor() {
    try {
      if (existsSync(this.cachePath)) return JSON.parse(readFileSync(this.cachePath, 'utf8'))
    } catch (error) {
      console.warn('Unable to read trusted time:', error)
    }
    return null
  }

  async synchronize() {
    let lastError
    for (const server of SERVERS) {
      try {
        const trustedTimeMs = await queryServer(server)
        this.anchor = {
          trustedTimeMs,
          uptimeMs: os.uptime() * 1000,
          localTimeMs: Date.now(),
          synchronizedAt: new Date(trustedTimeMs).toISOString(),
          server
        }
        writeFileSync(this.cachePath, JSON.stringify(this.anchor, null, 2), 'utf8')
        return this.status()
      } catch (error) {
        lastError = error
      }
    }
    if (!this.anchor) throw lastError || new Error('Trusted time is unavailable')
    return this.status()
  }

  now() {
    if (!this.anchor) return Date.now()
    const currentUptime = os.uptime() * 1000
    if (currentUptime >= this.anchor.uptimeMs) {
      return this.anchor.trustedTimeMs + (currentUptime - this.anchor.uptimeMs)
    }
    return this.anchor.trustedTimeMs + Math.max(0, Date.now() - this.anchor.localTimeMs)
  }

  status() {
    return {
      now: this.now(),
      trusted: Boolean(this.anchor),
      server: this.anchor?.server || null,
      synchronizedAt: this.anchor?.synchronizedAt || null
    }
  }
}
