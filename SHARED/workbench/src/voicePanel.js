import { encodeWav, VoiceActivity, SpeechSentences } from './voiceAudio.js'

export function createVoicePanel({ api, onTranscript, onInterrupt = () => {}, settingsOnly = false }) {
  const element = document.createElement('section'); element.className = 'os-voice-panel'
  element.setAttribute('aria-label', '实时语音对话')
  const status = document.createElement('p'); status.className = 'os-voice-status'; status.setAttribute('role', 'status')
  const label = document.createElement('label'); label.textContent = '音色 '
  const preset = document.createElement('select'); preset.setAttribute('aria-label', '语音音色')
  for (const [value, text] of [['laomushi', '老牧师 · GPT-SoVITS'], ['gpt-sovits', 'GPT-SoVITS · 自定义音色']]) { const item = new Option(text, value); preset.add(item) }
  label.append(preset)
  const custom = document.createElement('div'); custom.className = 'os-voice-custom'; custom.hidden = true
  const referenceText = document.createElement('textarea'); referenceText.placeholder = '参考音频中说的话（中文）'; referenceText.setAttribute('aria-label', '参考音频文本'); referenceText.maxLength = 500
  const buttons = document.createElement('div'); buttons.className = 'os-voice-buttons'
  let active = false, listening = false, epoch = 0, media, context, source, processor, mute, vad, audio, endAudio, closed = false, state, busy = false
  const show = text => { if (!closed) status.textContent = text }
  const fail = error => show(error?.message || String(error))
  const makeButton = (text, fn, parent = buttons) => {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = text
    button.onclick = () => Promise.resolve().then(fn).catch(fail); parent.append(button); return button
  }
  const apply = next => {
    state = next; preset.value = next.config.preset; referenceText.value = next.config.referenceText
    custom.hidden = preset.value !== 'gpt-sovits'
    if (!active && !busy) show(next.message)
    install.disabled = busy || active || ['installing', 'starting', 'ready'].includes(next.phase)
    launch.disabled = active || busy || ['installing', 'starting'].includes(next.phase)
    preset.disabled = active || busy
  }
  const save = async () => apply(await api.configure({ preset: preset.value, referenceText: referenceText.value }))
  preset.onchange = () => save().catch(fail); referenceText.onchange = () => save().catch(fail)
  makeButton('选择参考音频（3–10 秒）', async () => { const result = await api.reference(); if (result) { apply(result); show('参考音频已保存') } }, custom)
  custom.append(referenceText)
  const stopAudio = () => { if (audio) { audio.pause(); audio.src = ''; audio = null } endAudio?.(); endAudio = null }
  const listen = () => { if (!active) return; vad?.reset(); listening = true; interrupt.disabled = true; show('正在聆听 · 说完自动发送') }
  async function play(encoded, token) {
    if (!active || epoch !== token) return
    const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0))
    const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }))
    try {
      audio = new Audio(url)
      await new Promise((resolve, reject) => {
        endAudio = resolve; audio.onended = resolve; audio.onerror = () => reject(Error('音频播放失败'))
        audio.play().catch(reject)
      })
    } finally { stopAudio(); URL.revokeObjectURL(url) }
  }
  async function receive(frames) {
    if (!active || !listening) return
    listening = false; interrupt.disabled = false; const token = ++epoch
    let tail = Promise.resolve(), synthesis = Promise.resolve(), speechError
    const sentences = new SpeechSentences()
    const queue = values => {
      for (const text of values) {
        const prepared = synthesis = synthesis.then(async () => {
          if (!active || epoch !== token || speechError) return
          if (!audio) show('正在合成语音…')
          return api.synthesize(text)
        }).catch(error => { speechError = error })
        tail = tail.then(async () => {
          const result = await prepared
          if (!result || !active || epoch !== token) return
          show('正在朗读 · 可打断并说话')
          await play(result.audio, token)
        }).catch(error => { speechError = error })
      }
    }
    try {
      show('正在识别…')
      const result = await api.transcribe(encodeWav(frames, context.sampleRate))
      if (!active || epoch !== token) return
      if (!result.text) { listen(); return }
      show('你说：' + result.text)
      await onTranscript(result.text, text => { if (active && epoch === token) queue(sentences.push(text)) })
      queue(sentences.push('', true)); await tail
      if (speechError) throw speechError
      if (active && epoch === token) listen()
    } catch (error) {
      if (active && epoch === token) { listening = false; interrupt.disabled = false; show((error.message || String(error)) + ' · 点“打断并说话”继续') }
    }
  }
  async function release() {
    listening = false; ++epoch; stopAudio()
    if (processor) { processor.onaudioprocess = null; processor.disconnect(); processor = null }
    source?.disconnect(); source = null; mute?.disconnect(); mute = null
    media?.getTracks().forEach(track => track.stop()); media = null
    const previous = context; context = null; if (previous) await previous.close().catch(() => {})
  }
  async function stop() {
    active = false; busy = false; onInterrupt(); await release()
    launch.disabled = false; hangup.disabled = true; interrupt.disabled = true; preset.disabled = false
    show('语音对话已结束 · 麦克风已关闭')
  }
  const install = makeButton('安装 / 修复组件', async () => {
    busy = true; apply(await api.status()); show('正在安装，请稍候…')
    try { await api.install() } finally { busy = false; apply(await api.status()) }
  })
  const launch = makeButton(settingsOnly ? '启动语音引擎' : '开始语音对话', async () => {
    if (active || busy) return
    busy = true; launch.disabled = true
    try {
      await save(); show('正在加载语音引擎…'); await api.start()
      if (closed) return
      if (settingsOnly) { apply(await api.status()); show('语音引擎就绪'); return }
      if (preset.value === 'gpt-sovits' && (!state.hasReference || !referenceText.value.trim())) throw Error('请先选择参考音频并填写对应文本')
      media = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false })
      if (closed) { media.getTracks().forEach(track => track.stop()); media = null; return }
      context = new AudioContext({ sampleRate: 16000 }); await context.resume()
      vad = new VoiceActivity(context.sampleRate)
      source = context.createMediaStreamSource(media); processor = context.createScriptProcessor(2048, 1, 1)
      mute = context.createGain(); mute.gain.value = 0
      source.connect(processor); processor.connect(mute); mute.connect(context.destination)
      processor.onaudioprocess = event => {
        if (!listening || !active) return
        const frames = vad.push(event.inputBuffer.getChannelData(0)); if (frames) void receive(frames)
      }
      active = true; hangup.disabled = false; preset.disabled = true; listen()
    } catch (error) { await release(); throw error }
    finally { busy = false; launch.disabled = active; if (!active) preset.disabled = false }
  })
  const interrupt = makeButton('打断并说话', () => { if (!active) return; ++epoch; stopAudio(); onInterrupt(); listen() }); interrupt.disabled = true
  const hangup = makeButton('挂断', stop); hangup.disabled = true
  if (settingsOnly) { interrupt.hidden = true; hangup.hidden = true }
  makeButton('停止引擎', async () => { await stop(); apply(await api.stop()) })
  const details = document.createElement('details'), summary = document.createElement('summary'); summary.textContent = '语音设置与组件'
  const note = document.createElement('p'); note.className = 'os-voice-note'
  note.textContent = '录音在本机识别后，文字发送给当前聊天模型；回复按句朗读。播放期间暂停收音，点“打断并说话”继续。首次安装需下载约 6 GB，预留 20 GB 空间。'
  details.append(summary, label, custom, note)
  element.append(details, buttons, status)
  const unsubscribe = api.onStatus?.(next => { if (!closed) { apply(next); if (!active) show(next.message) } })
  api.status().then(apply).catch(fail)
  return { element, stop, close: () => { closed = true; unsubscribe?.(); void stop(); element.remove() } }
}
