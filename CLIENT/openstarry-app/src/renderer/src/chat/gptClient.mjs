export async function watchGptTask(api, { signal, onEvent, ...value }) {
  signal?.throwIfAborted()
  const watchId = crypto.randomUUID()
  let eventError
  const abort = () => { void api.unwatch({ watchId }).catch(() => {}) }
  const off = api.onEvent(event => {
    if (event.watchId !== watchId || signal?.aborted || eventError) return
    try { onEvent(event) } catch (error) { eventError = error; abort() }
  })
  signal?.addEventListener('abort', abort, { once: true })
  try {
    const result = await api.watch({ ...value, watchId })
    if (eventError) throw eventError
    signal?.throwIfAborted()
    return result
  } finally { off(); signal?.removeEventListener('abort', abort) }
}
