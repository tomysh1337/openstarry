import { createApp } from 'vue'
import { createPinia } from 'pinia'
import './assets/global.css'
import './assets/tab_card_global.css'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import App from './App.vue'
import router, { registerDynamicRoutes } from '@router/index'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'
import { useAppCacheData  } from './store/app'
import {
  // create naive ui
  create,
  // component
  NButton
} from 'naive-ui'
const naive = create({
  components: [NButton]
})



async function bootstrap() {
  registerDynamicRoutes()
  const app = createApp(App)

  for (const [key, component] of Object.entries(ElementPlusIconsVue)) {
    app.component(key, component)
  }

  app.use(router)
  app.use(ElementPlus)
  app.use(naive)

  const pinia = createPinia()
  app.use(pinia)

  const store = useAppCacheData()
  await store.init()

  app.mount('#app')
}

function showBootstrapError(error) {
  console.error('Renderer bootstrap failed:', error)
  const root = document.querySelector('#app')
  if (!root) return
  root.innerHTML = `
    <main style="min-height:100vh;display:grid;place-content:center;padding:32px;background:#f6f7fb;color:#20222a;font-family:system-ui,sans-serif;text-align:center">
      <h1 style="margin:0 0 10px;font-size:24px">OpenStarry NextGen 启动遇到问题</h1>
      <p style="margin:0 0 18px;color:#626773">界面初始化失败，请重新打开软件。诊断信息已写入本地日志。</p>
      <button id="reload-app" style="justify-self:center;padding:9px 18px;border:0;border-radius:9px;background:#5267f7;color:white;cursor:pointer">重新加载</button>
    </main>`
  document.querySelector('#reload-app')?.addEventListener('click', () => location.reload())
}

window.addEventListener('error', (event) => console.error('Renderer error:', event.error || event.message))
window.addEventListener('unhandledrejection', (event) => console.error('Renderer rejection:', event.reason))
bootstrap().catch(showBootstrapError)
