import { icon } from './icons.js'

const node = (tag, className, text = '') => {
  const element = document.createElement(tag)
  element.className = className
  element.textContent = text
  return element
}

// Keep focus on the combobox; the portalled list escapes editor/container clipping.
export function createPicker({ label, className = '', items = [], value, placement = 'below', onChange = () => {} }) {
  const trigger = node('button', 'os-picker ' + className)
  const caption = node('span', 'os-picker-caption')
  const chevron = icon('chevron')
  chevron.classList.add('os-picker-chevron')
  trigger.type = 'button'
  trigger.setAttribute('role', 'combobox')
  trigger.setAttribute('aria-label', label)
  trigger.setAttribute('aria-haspopup', 'listbox')
  trigger.setAttribute('aria-expanded', 'false')
  trigger.append(caption, chevron)

  let choices = items, selected = value ?? items[0]?.value ?? '', active = -1
  let menu, list, listeners, search = '', lastKey = 0
  const id = 'os-picker-' + crypto.randomUUID()
  const enabled = () => choices.map((item, index) => item.disabled ? -1 : index).filter(index => index >= 0)

  function updateCaption() {
    const item = choices.find(item => item.value === selected)
    caption.textContent = item?.label || '请选择'
    trigger.title = caption.textContent
    trigger.dataset.value = selected
  }
  function activate(index) {
    active = index
    const option = list?.children[index]
    if (!option) return
    for (const child of list.children) child.classList.toggle('is-active', child === option)
    trigger.setAttribute('aria-activedescendant', option.id)
    option.scrollIntoView({ block: 'nearest' })
  }
  function close(restoreFocus = false) {
    listeners?.abort()
    listeners = null
    menu?.remove()
    menu = list = null
    trigger.setAttribute('aria-expanded', 'false')
    trigger.removeAttribute('aria-controls')
    trigger.removeAttribute('aria-activedescendant')
    search = ''
    if (restoreFocus && trigger.isConnected) trigger.focus({ preventScroll: true })
  }
  function choose(index) {
    const item = choices[index]
    if (!item || item.disabled) return
    const changed = selected !== item.value
    selected = item.value
    updateCaption()
    close(true)
    if (changed) onChange(selected)
  }
  function position() {
    if (!menu) return
    const rect = trigger.getBoundingClientRect(), viewport = window.visualViewport
    const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0
    const width = viewport?.width || innerWidth, height = viewport?.height || innerHeight
    if (!trigger.isConnected || !trigger.getClientRects().length || rect.bottom < top || rect.top > top + height) { close(); return }
    const availableAbove = Math.max(0, rect.top - top - 14)
    const availableBelow = Math.max(0, top + height - rect.bottom - 14)
    const preferAbove = placement === 'above'
    const above = preferAbove ? availableAbove >= 180 || availableAbove >= availableBelow : availableBelow < 180 && availableAbove > availableBelow
    const menuWidth = Math.min(Math.max(280, rect.width), width - 16)
    menu.style.width = menuWidth + 'px'
    menu.style.maxHeight = Math.min(360, above ? availableAbove : availableBelow) + 'px'
    menu.style.left = Math.max(left + 8, Math.min(rect.left, left + width - menuWidth - 8)) + 'px'
    menu.style.top = (above ? rect.top - menu.getBoundingClientRect().height - 6 : rect.bottom + 6) + 'px'
    menu.dataset.side = above ? 'above' : 'below'
  }
  function open(startAtEnd = false) {
    if (trigger.disabled || menu || !enabled().length) return
    listeners = new AbortController()
    menu = node('div', 'os-picker-menu')
    const style = getComputedStyle(trigger)
    for (const name of ['--ide-bg', '--ide-panel', '--ide-text', '--ide-muted', '--ide-line', '--ide-soft', '--ide-accent', '--agent-accent']) menu.style.setProperty(name, style.getPropertyValue(name))
    menu.style.fontFamily = style.fontFamily
    menu.style.colorScheme = style.colorScheme
    list = node('div', 'os-picker-options')
    list.id = id
    list.setAttribute('role', 'listbox')
    list.setAttribute('aria-label', label)
    for (const [index, item] of choices.entries()) {
      const row = node('div', 'os-picker-option'), copy = node('span', 'os-picker-copy')
      row.id = id + '-' + index
      row.setAttribute('role', 'option')
      row.setAttribute('aria-selected', String(item.value === selected))
      if (item.disabled) row.setAttribute('aria-disabled', 'true')
      if (item.icon) row.append(icon(item.icon))
      copy.append(node('span', 'os-picker-name', item.label))
      if (item.description) copy.append(node('span', 'os-picker-description', item.description))
      const check = icon('check'); check.classList.add('os-picker-check')
      row.append(copy, check)
      row.onpointerdown = event => event.preventDefault()
      row.onpointermove = () => { if (!item.disabled && active !== index) activate(index) }
      row.onclick = () => choose(index)
      list.append(row)
    }
    menu.append(node('div', 'os-picker-heading', label), list)
    document.body.append(menu)
    trigger.setAttribute('aria-controls', id)
    trigger.setAttribute('aria-expanded', 'true')
    position()
    const indexes = enabled(), current = choices.findIndex(item => item.value === selected && !item.disabled)
    activate(current >= 0 ? current : startAtEnd ? indexes.at(-1) : indexes[0])
    const inside = target => trigger.contains(target) || menu?.contains(target)
    document.addEventListener('pointerdown', event => { if (!inside(event.target)) close() }, { capture: true, signal: listeners.signal })
    document.addEventListener('focusin', event => { if (!inside(event.target)) close() }, { signal: listeners.signal })
    document.addEventListener('scroll', event => { if (!menu?.contains(event.target)) position() }, { capture: true, signal: listeners.signal })
    window.addEventListener('resize', position, { signal: listeners.signal })
    window.visualViewport?.addEventListener('resize', position, { signal: listeners.signal })
    window.visualViewport?.addEventListener('scroll', position, { signal: listeners.signal })
  }
  trigger.onclick = () => menu ? close() : open()
  trigger.onkeydown = event => {
    if (event.key === 'Tab') { close(); return }
    if (event.key === 'Escape' && menu) { event.preventDefault(); event.stopPropagation(); close(true); return }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) {
      event.preventDefault()
      if (!menu) { open(event.key === 'ArrowUp' || event.key === 'End'); return }
      if (event.key === 'Enter' || event.key === ' ') { choose(active); return }
      const indexes = enabled(), cursor = indexes.indexOf(active)
      activate(event.key === 'Home' ? indexes[0] : event.key === 'End' ? indexes.at(-1) : indexes[(cursor + (event.key === 'ArrowDown' ? 1 : -1) + indexes.length) % indexes.length])
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && !event.isComposing) {
      event.preventDefault()
      if (!menu) open()
      search = (Date.now() - lastKey > 700 ? '' : search) + event.key.toLocaleLowerCase()
      lastKey = Date.now()
      const match = choices.findIndex(item => !item.disabled && item.label.toLocaleLowerCase().startsWith(search))
      if (match >= 0) activate(match)
    }
  }
  updateCaption()
  return {
    element: trigger,
    get value() { return selected },
    set value(next) { selected = next; close(); updateCaption() },
    get disabled() { return trigger.disabled },
    set disabled(next) { trigger.disabled = next; if (next) close() },
    setItems(next, value = selected) { close(); choices = next; selected = next.some(item => item.value === value) ? value : next[0]?.value ?? ''; updateCaption() },
    close,
    destroy() { close(); trigger.onclick = trigger.onkeydown = null; trigger.remove() },
  }
}
