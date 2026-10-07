// invoke replies and renderer events use separate IPC deliveries. Await the last
// numbered chunk before removing the listener, even if invoke resolves first.
export function createIdeHttpRequest(api) {
  return async function request({ signal, onChunk, ...value }) {
    signal?.throwIfAborted()
    const id = crypto.randomUUID()
    let chunkError,
      received = 0,
      wake = () => {}
    const abort = () => {
      api.cancelHttp({ id }).catch(() => {})
      wake()
    }
    const unsubscribe = onChunk
      ? api.onHttpChunk((event) => {
          if (event.id !== id || signal?.aborted || chunkError) return
          try {
            if (event.seq && event.seq <= received) return
            if (event.seq && event.seq !== received + 1) throw Error('流式数据缺失，已保留接收内容')
            onChunk(event.text)
            received = event.seq || received + 1
          } catch (error) {
            chunkError = error
            abort()
          }
          wake()
        })
      : () => {}
    signal?.addEventListener('abort', abort, { once: true })
    let timer
    try {
      const result = await api.http({ id, ...value, stream: Boolean(onChunk) })
      if (onChunk && received < (result.lastSeq || 0) && !chunkError && !signal?.aborted) {
        await new Promise((resolve, reject) => {
          wake = () => {
            if (received >= result.lastSeq || chunkError || signal?.aborted) resolve()
          }
          timer = setTimeout(() => reject(Error('回复收尾数据未到达，已保留接收内容')), 5000)
          wake()
        })
      }
      if (chunkError) throw chunkError
      signal?.throwIfAborted()
      return result
    } catch (error) {
      throw chunkError || (signal?.aborted ? signal.reason : error)
    } finally {
      clearTimeout(timer)
      unsubscribe()
      signal?.removeEventListener('abort', abort)
    }
  }
}
