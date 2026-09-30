import { reasoningLevels } from './completion.js'
import { icon } from './icons.js'

export function createReasoningPicker() {
  const trigger = document.createElement('button')
  trigger.type = 'button'; trigger.className = 'os-reasoning-trigger'
  trigger.setAttribute('aria-label', '思考等级'); trigger.setAttribute('aria-haspopup', 'dialog'); trigger.setAttribute('aria-expanded', 'false')
  let endpoint = '', model = '', value = 'medium', popup, listeners
  const key = () => 'openstarry.ide.reasoning.' + JSON.stringify([endpoint, model])
  const current = () => reasoningLevels.find(level => level.value === value) || reasoningLevels[1]
  const label = document.createElement('span'); label.className = 'os-reasoning-caption'; trigger.append(label, icon('chevron'))
  function caption() { label.textContent = current().label; trigger.title = '思考等级 · ' + current().label; trigger.dataset.value = value }
  function close(focus = false) { listeners?.abort(); popup?.remove(); popup = listeners = null; trigger.setAttribute('aria-expanded', 'false'); if (focus) trigger.focus() }
  function open() {
    if (trigger.disabled) return
    if (popup) { close(); return }
    popup = document.createElement('section'); popup.className = 'os-reasoning-popup'; popup.setAttribute('role', 'dialog'); popup.setAttribute('aria-label', '选择思考等级')
    const style = getComputedStyle(trigger)
    for (const name of ['--ide-bg', '--ide-panel', '--ide-text', '--ide-muted', '--ide-line', '--ide-accent', '--ide-soft']) popup.style.setProperty(name, style.getPropertyValue(name))
    popup.style.colorScheme = style.colorScheme
    const head = document.createElement('div'); head.className = 'os-reasoning-head'
    const copy = document.createElement('div'), title = document.createElement('strong'), subtitle = document.createElement('small')
    subtitle.textContent = model; subtitle.title = model; copy.append(title, subtitle)
    const reset = document.createElement('button'); reset.type = 'button'; reset.setAttribute('aria-label', '恢复中等思考'); reset.title = '恢复中等'; reset.append(icon('history')); head.append(copy, reset)
    const track = document.createElement('div'); track.className = 'os-reasoning-track'
    const slider = document.createElement('input'); slider.type = 'range'; slider.min = '0'; slider.max = '4'; slider.step = '1'; slider.setAttribute('aria-label', '思考等级滑杆')
    const rail = document.createElement('div'); rail.className = 'os-reasoning-rail'; rail.setAttribute('aria-hidden', 'true')
    for (const name of ['fill', 'flow', 'stars']) { const layer = document.createElement('span'); layer.className = 'os-reasoning-' + name; rail.append(layer) }
    const thumb = document.createElement('span'); thumb.className = 'os-reasoning-thumb'; thumb.setAttribute('aria-hidden', 'true')
    const ticks = document.createElement('div'); ticks.className = 'os-reasoning-ticks'; ticks.setAttribute('aria-hidden', 'true')
    for (let index = 0; index < 5; index++) ticks.append(document.createElement('i'))
    rail.append(ticks); track.append(rail, thumb, slider)
    const choices = document.createElement('div'); choices.className = 'os-reasoning-choices'
    const note = document.createElement('p'); note.textContent = '等级越高，等待通常越久。实际支持取决于当前模型与接口。'
    let drag = null
    const lastIndex = reasoningLevels.length - 1
    const moveThumb = progress => track.style.setProperty('--effort-progress', String(progress))
    function update() {
      const index = reasoningLevels.findIndex(level => level.value === value)
      title.textContent = current().label; slider.value = index; slider.setAttribute('aria-valuetext', current().label)
      popup.dataset.effort = value
      if (!drag?.moved) moveThumb(index / lastIndex)
      for (const [i, button] of [...choices.children].entries()) button.setAttribute('aria-pressed', String(i === index))
      caption()
    }
    function select(index) {
      const next = reasoningLevels[Math.max(0, Math.min(lastIndex, Math.round(index)))].value
      if (value !== next) { value = next; try { localStorage.setItem(key(), value) } catch {} }
      update()
    }
    function progressAt(event) {
      const rect = track.getBoundingClientRect(), radius = thumb.offsetWidth / 2
      return Math.max(0, Math.min(1, (event.clientX - rect.left - radius) / Math.max(1, rect.width - radius * 2)))
    }
    function followPointer(event) {
      const progress = progressAt(event)
      if (drag.moved) moveThumb(progress)
      if (reasoningLevels[Math.round(progress * lastIndex)].value !== value) select(progress * lastIndex)
    }
    function finishDrag(event) {
      if (!drag || event.pointerId !== drag.pointerId) return
      if (event.type === 'pointerup') followPointer(event)
      // Resolve the last continuous position before enabling the snap transition.
      thumb.getBoundingClientRect()
      drag = null; delete track.dataset.dragging; delete track.dataset.pressed; update()
      if (slider.hasPointerCapture(event.pointerId)) slider.releasePointerCapture(event.pointerId)
    }
    slider.onpointerdown = event => {
      if (!event.isPrimary || event.button !== 0 || drag) return
      event.preventDefault(); slider.focus({ preventScroll: true })
      drag = { pointerId: event.pointerId, startX: event.clientX, moved: false }
      track.dataset.pressed = 'true'; slider.setPointerCapture(event.pointerId); followPointer(event)
    }
    slider.onpointermove = event => {
      if (!drag || event.pointerId !== drag.pointerId) return
      if (!drag.moved && Math.abs(event.clientX - drag.startX) < 2) return
      drag.moved = true; track.dataset.dragging = 'true'; followPointer(event)
    }
    slider.onpointerup = slider.onpointercancel = slider.onlostpointercapture = finishDrag
    reasoningLevels.forEach((level, index) => { const button = document.createElement('button'); button.type = 'button'; button.textContent = level.label; button.onclick = () => select(index); choices.append(button) })
    reset.onclick = () => select(1); slider.oninput = () => select(Number(slider.value))
    popup.append(head, track, choices, note); document.body.append(popup); update()
    const position = () => {
      if (!popup) return
      const rect = trigger.getBoundingClientRect(), viewport = window.visualViewport
      const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0, width = viewport?.width || innerWidth, height = viewport?.height || innerHeight
      if (!trigger.getClientRects().length) { close(); return }
      popup.style.width = Math.min(276, width - 16) + 'px'
      popup.style.maxHeight = Math.max(80, height - 16) + 'px'
      popup.style.left = Math.max(left + 8, Math.min(rect.right - popup.offsetWidth, left + width - popup.offsetWidth - 8)) + 'px'
      popup.style.top = Math.max(top + 8, Math.min(rect.top - popup.offsetHeight - 8, top + height - popup.offsetHeight - 8)) + 'px'
    }
    position(); trigger.setAttribute('aria-expanded', 'true'); slider.focus()
    listeners = new AbortController()
    const inside = target => trigger.contains(target) || popup?.contains(target)
    document.addEventListener('pointerdown', event => { if (!inside(event.target)) close() }, { signal: listeners.signal, capture: true })
    document.addEventListener('focusin', event => { if (!inside(event.target)) close() }, { signal: listeners.signal })
    popup.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); close(true) } }, { signal: listeners.signal })
    window.addEventListener('resize', position, { signal: listeners.signal })
    document.addEventListener('scroll', position, { capture: true, signal: listeners.signal })
    window.visualViewport?.addEventListener('resize', position, { signal: listeners.signal })
    window.visualViewport?.addEventListener('scroll', position, { signal: listeners.signal })
  }
  trigger.onclick = open; caption()
  return {
    element: trigger,
    get value() { return value },
    set disabled(next) { trigger.disabled = next; if (next) close() },
    setModel(config) {
      if (endpoint === config?.endpoint && model === config?.model) return
      close(); endpoint = config?.endpoint || ''; model = config?.model || ''; value = 'medium'
      try { const saved = localStorage.getItem(key()); if (reasoningLevels.some(level => level.value === saved)) value = saved } catch {}
      caption()
    },
    destroy() { close(); trigger.remove() },
  }
}
