import { ipcMain } from 'electron'

import { AI_API_BASE, MEMORY_API_BASE, FILE_API_BASE } from '../config'

// =====================================================
//                      Ai config
// =====================================================
export function registerAiConfigIpc() {
  console.log('registerAiConfigIpc...')

  // Get models list for predefined providers
  ipcMain.handle('api:get_models_list', async (event, model_provider, api_key, config) => {
    try {
      const res = await fetch(`${AI_API_BASE}/api/v1/get_models_list`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model_provider: model_provider,
          api_key: api_key,
          config: config
        }),
      })

      const data = await res.json()

      if (!res.ok) {
        throw new Error(data.detail || "Get models list failed.")
      }

      return data.messages

    } catch (err) {
      console.error("[ipc:get_models_list] error:", err)
      throw err
    }
  })

  ipcMain.handle('api:set_proxy', async (event, http_proxy, https_proxy, no_proxy) => {
    try {
      const res = await fetch(`${AI_API_BASE}/api/v1/set_proxy`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          http_proxy: http_proxy,
          https_proxy: https_proxy,
          no_proxy: no_proxy,
        }),
      })

      const data = await res.json()

      if (!res.ok) {
        throw new Error(data.detail || "Set proxy failed.")
      }

      return data.messages

    } catch (err) {
      console.error("[ipc:set_proxy] error:", err)
      throw err
    }
  })

  ipcMain.handle('api:clear_vision_cache', async (event) => {
    try {
      const res = await fetch(`${AI_API_BASE}/api/v1/clear_vision_cache`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
        }
      })

      const data = await res.json()

      if (!res.ok) {
        throw new Error(data.detail || "Clear cache failed.")
      }
      if (!data.success) {
        throw new Error(data.messages || "Clear cache failed.")
      }

      return data.messages

    } catch (err) {
      console.error("[ipc:clear_vision_cache] error:", err)
      throw err
    }
  })

  ipcMain.handle('api:create_llm_provider', async (event, cid, provider_meta) => {
    try {
      const res = await fetch(`${MEMORY_API_BASE}/provider/create_llm_provider`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          client_id: cid,
          ...provider_meta
        }),
      })

      const data = await res.json()

      if (!res.ok || !data.success) {
        throw new Error(data.detail || data.messages || "Create providers failed.")
      }

      return data.messages

    } catch (err) {
      console.error("[ipc:create_llm_provider] error:", err)
      throw err
    }
  })

  ipcMain.handle('api:get_llm_providers', async (event, cid) => {
    try {
      const res = await fetch(`${MEMORY_API_BASE}/provider/get_llm_providers`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          client_id: cid
        }),
      })

      const data = await res.json()

      if (!res.ok || !data.success) {
        throw new Error(data.detail || data.messages || "Get providers failed.")
      }

      return data.messages

    } catch (err) {
      console.error("[ipc:get_llm_providers] error:", err)
      throw err
    }
  })

  ipcMain.handle('api:update_llm_provider', async (event, provider_id, cid, new_meta) => {
    try {
      const res = await fetch(`${MEMORY_API_BASE}/provider/update_llm_provider`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          provider_id: provider_id,
          client_id: cid,
          ...new_meta
        }),
      })

      const data = await res.json()

      if (!res.ok || !data.success) {
        throw new Error(data.detail || data.messages || "Update providers failed.")
      }

      return data.messages

    } catch (err) {
      console.error("[ipc:update_llm_provider] error:", err)
      throw err
    }
  })

  // Fetch models list for custom provider based on endpoint and api key
  ipcMain.handle('api:auto_fetch_model_list', async (_event, endpoint, api_key) => {
    const base = new URL(String(endpoint).replace(/\/(chat\/completions|models)\/?$/, '').replace(/\/+$/, ''))
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw Error('接口地址格式错误')
    const response = await fetch(base.href.replace(/\/+$/, '') + '/models', {
      headers: api_key ? { Authorization: 'Bearer ' + api_key } : {}, signal: AbortSignal.timeout(20000)
    })
    const data = await response.json().catch(() => { throw Error('接口返回的不是 JSON，请检查 /v1 等接口路径') })
    if (!response.ok) throw Error('获取模型失败：HTTP ' + response.status)
    const list = Array.isArray(data) ? data : data.data || data.models
    if (!Array.isArray(list)) throw Error('响应缺少模型列表，可手动填写模型 ID')
    return [...new Set(list.map(item => typeof item === 'string' ? item : item?.id || item?.name).filter(id => typeof id === 'string' && id.trim()).map(id => id.trim()))]
  })

  ipcMain.handle('api:create_mcp_server', async (event, cid, mcp_meta) => {
    try {
      const res = await fetch(`${MEMORY_API_BASE}/mcp/create_mcp_server`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_id: cid,
          ...mcp_meta,
        }),
      })

      const data = await res.json()

      if (!res.ok || !data.success) {
        throw new Error(
          data.detail ||
          data.messages ||
          'Create mcp server failed.'
        )
      }

      return data.messages

    } catch (err) {

      console.error(
        '[ipc:create_mcp_server] error:',
        err
      )

      throw err

    }
  })

  ipcMain.handle('api:get_mcp_servers', async (event, cid) => {
    try {
      const res = await fetch(`${MEMORY_API_BASE}/mcp/get_mcp_servers`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_id: cid,
        }),
      })

      const data = await res.json()

      if (!res.ok || !data.success) {
        throw new Error(
          data.detail ||
          data.messages ||
          'Get mcp servers failed.'
        )
      }

      return data.messages

    } catch (err) {

      console.error(
        '[ipc:get_mcp_servers] error:',
        err
      )

      throw err

    }
  })

  ipcMain.handle('api:update_mcp_server', async (event, mcp_id, cid, new_meta) => {
    try {
      const res = await fetch(
        `${MEMORY_API_BASE}/mcp/update_mcp_server`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            mcp_id,
            client_id: cid,
            ...new_meta,
          }),
        }
      )

      const data = await res.json()

      if (!res.ok || !data.success) {
        throw new Error(
          data.detail ||
          data.messages ||
          'Update mcp server failed.'
        )
      }

      return data.messages

    } catch (err) {

      console.error(
        '[ipc:update_mcp_server] error:',
        err
      )

      throw err

    }
  })

  //Get mcp provided tools list
  ipcMain.handle('api:get_mcp_tools', async (event, mcp_id, cid, mcp_meta) => {
    try {
      const res = await fetch(`${AI_API_BASE}/api/v1/get_mcp_tools`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          mcp_id,
          client_id: cid,
          mcp_meta
        }),
      })

      const data = await res.json()

      if (!res.ok || !data.success) {
        throw new Error(
          data.detail ||
          data.messages ||
          'Get mcp tools failed.'
        )
      }

      return data.messages

    } catch (err) {

      console.error(
        '[ipc:get_mcp_tools] error:',
        err
      )

      throw err

    }
  })

}