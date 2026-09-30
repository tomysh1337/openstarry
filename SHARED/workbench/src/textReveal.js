// Reveal only text that has already arrived. History, corrections and terminal
// events are applied immediately; no completed answer is replayed as a stream.
export function createTextReveal({ onText, request = callback => requestAnimationFrame(callback), cancel = handle => cancelAnimationFrame(handle),
  reducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true,
  visible = () => !globalThis.document?.hidden, maxLagMs = 1000 } = {}) {
  let shown = '', target = '', frame = null, initialized = false, closed = false, lastFrame = 0, finishAt = 0
  const stop = () => { if (frame !== null) cancel(frame); frame = null; lastFrame = 0; finishAt = 0 }
  const publish = value => { if (shown !== value) { shown = value; onText(value) } }
  const tick = now => {
    frame = null
    if (closed) return
    if (reducedMotion() || !visible()) { publish(target); lastFrame = 0; finishAt = 0; return }
    const remaining = Array.from(target.slice(shown.length))
    const elapsed = lastFrame ? Math.max(1, Math.min(100, now - lastFrame)) : 16
    finishAt ||= now + maxLagMs
    const count = Math.max(1, Math.ceil(remaining.length * elapsed / Math.max(elapsed, finishAt - now)))
    publish(shown + remaining.slice(0, count).join(''))
    lastFrame = now
    if (shown !== target) frame = request(tick); else { lastFrame = 0; finishAt = 0 }
  }
  return {
    update(value, { streaming = false, reset = false } = {}) {
      if (closed) return
      const next = String(value ?? '')
      const replace = !initialized || reset || !streaming || !next.startsWith(target) || reducedMotion() || !visible()
      initialized = true; target = next
      if (replace) { stop(); publish(target); return }
      if (shown !== target && frame === null) frame = request(tick)
    },
    flush() { stop(); publish(target) },
    close() { closed = true; stop() },
    get text() { return shown }
  }
}
