import { icon } from './icons.js'

export function createChatTabs({ panelId, onSelect, onClose }) {
  const element = document.createElement('div')
  element.className = 'os-chat-tabs'; element.setAttribute('role', 'tablist'); element.setAttribute('aria-label', '聊天标签页')
  const views = new Map()
  let items = [], activeId = ''
  function reveal(id) {
    const view = views.get(id)
    if (!view || !element.clientWidth) return
    const bounds = element.getBoundingClientRect(), tab = view.wrapper.getBoundingClientRect()
    if (tab.left < bounds.left) element.scrollLeft -= bounds.left - tab.left
    else if (tab.right > bounds.right) element.scrollLeft += tab.right - bounds.right
  }
  function focus(id) { views.get(id)?.tab.focus({ preventScroll: true }); reveal(id) }
  const resize = new ResizeObserver(() => reveal(activeId)); resize.observe(element)
  element.onkeydown = event => {
    const tab = event.target.closest('[role=tab]')
    if (!tab) return
    const index = items.findIndex(item => item.id === tab.dataset.chatId)
    let next
    if (event.key === 'ArrowRight') next = items[(index + 1) % items.length]
    if (event.key === 'ArrowLeft') next = items[(index - 1 + items.length) % items.length]
    if (event.key === 'Home') next = items[0]
    if (event.key === 'End') next = items.at(-1)
    if (next) { event.preventDefault(); onSelect(next.id); focus(next.id) }
    if (event.key === 'Delete') { event.preventDefault(); onClose(tab.dataset.chatId) }
  }
  return {
    element, focus, destroy: () => resize.disconnect(),
    update(nextItems, selected) {
      const changed = selected !== activeId || items.length !== nextItems.length || items.some((item, index) => item.id !== nextItems[index]?.id)
      items = nextItems; activeId = selected
      for (const [id, view] of views) if (!items.some(item => item.id === id)) { view.wrapper.remove(); views.delete(id) }
      items.forEach((item, index) => {
        let view = views.get(item.id)
        if (!view) {
          const wrapper = document.createElement('div'); wrapper.className = 'os-chat-tab'; wrapper.setAttribute('role', 'presentation')
          const tab = document.createElement('button'); tab.type = 'button'; tab.className = 'os-chat-tab-title'; tab.setAttribute('role', 'tab'); tab.id = 'os-chat-tab-' + item.id; tab.dataset.chatId = item.id; tab.setAttribute('aria-controls', panelId)
          const indicator = document.createElement('span'); indicator.className = 'os-chat-tab-indicator'; indicator.setAttribute('aria-hidden', 'true')
          const label = document.createElement('span'); label.className = 'os-chat-tab-label'; tab.append(indicator, label); tab.onclick = () => onSelect(item.id)
          const close = document.createElement('button'); close.type = 'button'; close.className = 'os-chat-tab-close'; close.append(icon('close')); close.onclick = () => onClose(item.id)
          wrapper.append(tab, close); view = { wrapper, tab, label, close }; views.set(item.id, view)
        }
        const current = item.id === selected
        if (view.label.textContent !== item.title) view.label.textContent = item.title
        view.wrapper.dataset.state = item.state || 'idle'; view.wrapper.classList.toggle('is-active', current)
        view.tab.setAttribute('aria-selected', String(current)); view.tab.tabIndex = current ? 0 : -1
        view.tab.title = item.title + (item.state === 'running' ? ' · 正在生成' : item.state === 'waiting' ? ' · 等待回答' : '')
        view.close.setAttribute('aria-label', '关闭对话 ' + item.title); view.close.title = '关闭标签，保留聊天记录'; view.close.tabIndex = current ? 0 : -1
        if (element.children[index] !== view.wrapper) element.insertBefore(view.wrapper, element.children[index] || null)
      })
      if (changed) reveal(selected)
    },
  }
}
