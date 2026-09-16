// AbortSignal.any/timeout are missing in older Android WebView versions.
export function timeoutSignal(milliseconds) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new DOMException('请求超时，请重试', 'TimeoutError')), milliseconds)
  timer.unref?.()
  return controller.signal
}
export function combineSignals(signals) {
  const controller = new AbortController()
  const abort = event => controller.abort(event.target.reason || new DOMException('已停止', 'AbortError'))
  for (const signal of signals) {
    if (signal.aborted) { controller.abort(signal.reason); break }
    signal.addEventListener('abort', abort, { once: true })
  }
  controller.signal.addEventListener('abort', () => signals.forEach(signal => signal.removeEventListener('abort', abort)), { once: true })
  return controller.signal
}
