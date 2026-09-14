import './style.css'
import {
  clearConfig,
  clearRecords,
  conversations,
  loadConfig,
  messages,
  saveConfig,
  synchronize
} from './syncClient.js'

const app = document.querySelector('#app')
let activeConversation = ''
let query = ''

function element(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}

function button(label, action, className = '') {
  const node = element('button', className, label)
  node.addEventListener('click', action)
  return node
}

function renderLogin(message = '') {
  app.replaceChildren()
  const shell = element('main', 'login-shell')
  const card = element('section', 'login-card')
  const logo = element('img', 'login-logo')
  logo.src = '/OpenStarry.png'
  logo.alt = 'OpenStarry'
  card.append(logo, element('h1', '', 'OpenStarry'), element('p', 'muted', '在 Android 与桌面之间同步聊天历史'))
  const server = element('input', 'field')
  server.value = 'https://openstarry.154-219-110-177.sslip.io'
  server.placeholder = '同步服务器'
  const user = element('input', 'field')
  user.value = 'tomysh'
  user.placeholder = '用户 ID'
  const token = element('input', 'field')
  token.type = 'password'
  token.placeholder = '访问令牌'
  const status = element('p', 'login-status', message)
  card.append(server, user, token, status)
  card.append(button('登录并同步', async () => {
    const config = {
      serverUrl: server.value,
      userId: user.value,
      token: token.value
    }
    if (!config.serverUrl || !config.userId || !config.token) {
      status.textContent = '请填写全部连接信息'
      return
    }
    status.textContent = '正在连接…'
    try {
      saveConfig(config)
      await synchronize(config, true)
      await renderApp()
    } catch (error) {
      clearConfig()
      status.textContent = error.message
    }
  }, 'primary wide'))
  shell.append(card)
  app.append(shell)
}

function formatMessageContent(value) {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value ?? '')
  }
}

async function renderMessages(container, conversationId) {
  container.replaceChildren()
  if (!conversationId) {
    container.append(element('div', 'empty', '选择一个会话查看聊天历史'))
    return
  }
  const list = await messages(conversationId)
  if (!list.length) {
    container.append(element('div', 'empty', '这个会话还没有消息'))
    return
  }
  for (const item of list) {
    const role = item.role === 'human' ? 'human' : 'ai'
    const bubble = element('article', 'message ' + role)
    bubble.append(
      element('div', 'message-role', role === 'human' ? '你' : 'OpenStarry'),
      element('div', 'message-content', formatMessageContent(item.content)),
      element('time', 'message-time', item.created_at || '')
    )
    container.append(bubble)
  }
  container.scrollTop = container.scrollHeight
}

async function renderConversationList(container, messagePane) {
  container.replaceChildren()
  const list = await conversations(query)
  if (!list.length) {
    container.append(element('div', 'empty small', '暂无同步会话'))
    return
  }
  if (!activeConversation || !list.some((item) => item.conversation_uid === activeConversation)) {
    activeConversation = list[0].conversation_uid
  }
  for (const item of list) {
    const row = element('button', 'conversation' + (item.conversation_uid === activeConversation ? ' active' : ''))
    row.append(
      element('strong', '', item.title || '未命名会话'),
      element('span', '', item.last_active_at || '')
    )
    row.addEventListener('click', async () => {
      activeConversation = item.conversation_uid
      await renderConversationList(container, messagePane)
      await renderMessages(messagePane, activeConversation)
    })
    container.append(row)
  }
  await renderMessages(messagePane, activeConversation)
}

async function renderApp() {
  const config = loadConfig()
  if (!config) {
    renderLogin()
    return
  }
  app.replaceChildren()
  const shell = element('main', 'app-shell')
  const header = element('header', 'topbar')
  const brand = element('div', 'brand')
  const logo = element('img', 'brand-logo')
  logo.src = '/OpenStarry.png'
  brand.append(logo, element('strong', '', 'OpenStarry'))
  const syncState = element('span', 'sync-state', '已离线缓存')
  const actions = element('div', 'top-actions')
  actions.append(
    button('同步', async () => {
      syncState.textContent = '同步中…'
      try {
        const count = await synchronize(config)
        syncState.textContent = count ? '收到 ' + count + ' 项更新' : '已是最新'
        await renderConversationList(listPane, messagePane)
      } catch (error) {
        syncState.textContent = '离线：' + error.message
      }
    }, 'primary'),
    button('退出', async () => {
      clearConfig()
      await clearRecords()
      activeConversation = ''
      renderLogin()
    })
  )
  header.append(brand, syncState, actions)

  const body = element('div', 'content')
  const sidebar = element('aside', 'sidebar')
  const search = element('input', 'search')
  search.placeholder = '搜索会话'
  const listPane = element('div', 'conversation-list')
  const messagePane = element('section', 'messages')
  search.addEventListener('input', async () => {
    query = search.value
    await renderConversationList(listPane, messagePane)
  })
  sidebar.append(search, listPane)
  body.append(sidebar, messagePane)
  shell.append(header, body)
  app.append(shell)
  await renderConversationList(listPane, messagePane)
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js'))
}

renderApp()
