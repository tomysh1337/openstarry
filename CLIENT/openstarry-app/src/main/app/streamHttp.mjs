// A reasoning stream can outlive an ordinary request. Only inactivity expires it;
// the Agent's configured run budget and explicit cancellation bound total time.
export async function streamHttp({
  url,
  method,
  headers,
  body,
  stream,
  controller,
  onChunk = () => {},
  idleTimeoutMs = stream ? 600000 : 180000
}) {
  const parsed = new URL(url)
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
    throw Error('请求地址格式错误')
  let timer
  const touch = () => {
    clearTimeout(timer)
    timer = setTimeout(
      () => controller.abort(Error('模型连接长时间没有返回数据，已保留接收内容，请重试')),
      idleTimeoutMs
    )
  }
  touch()
  try {
    const response = await fetch(parsed, { method, headers, body, signal: controller.signal })
    touch()
    const reader = response.body?.getReader(),
      parts = [],
      decoder = new TextDecoder()
    const streamed = Boolean(
      stream &&
      response.ok &&
      /text\/event-stream/i.test(response.headers.get('content-type') || '')
    )
    let total = 0
    try {
      if (reader)
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          touch()
          total += value.length
          if (total > 4 * 1024 * 1024) throw Error('响应超过大小上限')
          if (streamed) onChunk(decoder.decode(value, { stream: true }))
          else parts.push(Buffer.from(value))
        }
      if (streamed) onChunk(decoder.decode())
    } finally {
      await reader?.cancel().catch(() => {})
      reader?.releaseLock()
    }
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers),
      streamed,
      text: Buffer.concat(parts).toString('utf8')
    }
  } catch (error) {
    controller.signal.throwIfAborted()
    throw error
  } finally {
    clearTimeout(timer)
  }
}
