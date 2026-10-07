export function encodeWav(frames, sampleRate) {
  const count = frames.reduce((total, frame) => total + frame.length, 0)
  const buffer = new ArrayBuffer(44 + count * 2), view = new DataView(buffer)
  const tag = (offset, text) => [...text].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)))
  tag(0, 'RIFF'); view.setUint32(4, 36 + count * 2, true); tag(8, 'WAVE'); tag(12, 'fmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); tag(36, 'data'); view.setUint32(40, count * 2, true)
  let offset = 44
  for (const frame of frames) for (const sample of frame) { const value = Math.max(-1, Math.min(1, sample)); view.setInt16(offset, value * (value < 0 ? 32768 : 32767), true); offset += 2 }
  return new Uint8Array(buffer)
}

export class VoiceActivity {
  constructor(sampleRate, { threshold = .018, silenceMs = 850, maxSeconds = 18 } = {}) {
    Object.assign(this, { sampleRate, threshold, silenceMs, maxSeconds }); this.reset()
  }
  reset() { this.frames = []; this.before = []; this.samples = 0; this.silence = 0; this.voiced = 0 }
  push(frame) {
    const active = Math.sqrt(frame.reduce((sum, value) => sum + value * value, 0) / frame.length) > this.threshold
    if (!this.frames.length && !active) { this.before.push(frame.slice()); if (this.before.length > 3) this.before.shift(); return null }
    if (!this.frames.length) { this.frames.push(...this.before); this.before = [] }
    this.frames.push(frame.slice()); this.samples += frame.length
    if (active) { this.silence = 0; this.voiced += frame.length } else this.silence += frame.length
    if (this.silence * 1000 / this.sampleRate < this.silenceMs && this.samples / this.sampleRate < this.maxSeconds) return null
    const frames = this.voiced / this.sampleRate >= .3 ? this.frames : null
    this.reset(); return frames
  }
}

const plain = text => text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/https?:\/\/\S+/g, '').replace(/[*_`#>|]/g, '').trim()
export class SpeechSentences {
  constructor() { this.buffer = ''; this.code = false }
  push(text, final = false) {
    this.buffer += text
    const result = []
    while (this.buffer) {
      if (this.code) {
        const end = this.buffer.indexOf('```')
        if (end < 0) { if (this.buffer.length > 3) this.buffer = this.buffer.slice(-3); break }
        this.buffer = this.buffer.slice(end + 3); this.code = false; continue
      }
      const fence = this.buffer.indexOf('```')
      const match = /[。！？!?\n]|\.(?=\s)/.exec(this.buffer)
      let end = match ? match.index + 1 : -1
      if (fence >= 0 && (end < 0 || fence < end)) {
        const value = plain(this.buffer.slice(0, fence)); if (value) result.push(value)
        this.buffer = this.buffer.slice(fence + 3); this.code = true; continue
      }
      if (end < 0) end = this.buffer.length > 160 ? 140 : final ? this.buffer.length : -1
      if (end < 0) break
      const value = plain(this.buffer.slice(0, end)); this.buffer = this.buffer.slice(end)
      if (value) for (let i = 0; i < value.length; i += 180) result.push(value.slice(i, i + 180))
    }
    return result
  }
}
