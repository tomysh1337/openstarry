import { computed, reactive, ref, watch } from 'vue'
import { HomeWebChat, homeWebMessages, isHomeWebId } from './homeWebChat.mjs'
import { watchGptTask } from './gptClient.mjs'

export function useHomeWebChat({ api, appStore, owner, input, localStore, onNavigate = () => {}, onError = () => {} }) {
  const source = ref('api'), activeId = ref(''), state = reactive({ sessions: [], ready: false })
  const connection = ref(null), connecting = ref(false), navigating = ref(false)
  const client = new HomeWebChat({ api: { ...api, watch: value => watchGptTask(api, value) }, store: localStore, state })
  const isWeb = computed(() => source.value === 'chatgpt-web')
  // Web history belongs to this page; mini chat and API pages keep their backend ID.
  const currentId = computed({ get: () => isWeb.value ? activeId.value : appStore.current_history_id,
    set: value => {
      if (isWeb.value) activeId.value = value
      else {
        const previous = appStore.current_history_id
        appStore.current_history_id = value
        // A backend-created history consumes the new-chat draft.
        if (previous === '-1' && value !== '-1') drafts.delete('-1')
      }
    } })
  const session = computed(() => client.get(activeId.value))
  const messages = computed(() => reactive(homeWebMessages(session.value, owner.value, client.project)))
  const needsResume = computed(() => session.value?.turns.some(turn => !['complete', 'stopped', 'error'].includes(turn.answer.status)) && !session.value?.busy)
  const drafts = new Map()
  let switching = false, preferenceSave = Promise.resolve()
  const savePreferences = () => {
    if (!state.ready) return
    const values = { source: source.value, activeId: activeId.value }
    preferenceSave = preferenceSave.catch(() => {}).then(() => client.store.savePreferences(client.owner, values))
    void preferenceSave.catch(onError)
  }
  const saveDraft = () => {
    if (isWeb.value) client.draft(activeId.value, input.value)
    else drafts.set(String(appStore.current_history_id), input.value)
  }
  const stopDraftWatch = watch(input, () => { if (!switching) saveDraft() }, { flush: 'sync' })
  const stopIdWatch = watch(() => appStore.current_history_id, (id, old) => {
    if (isWeb.value || switching) return
    drafts.set(String(old), input.value)
    switching = true; input.value = drafts.get(String(id)) || ''; switching = false
  }, { flush: 'sync' })
  function activate(id) {
    saveDraft(); switching = true
    source.value = isHomeWebId(id) ? 'chatgpt-web' : 'api'
    if (isWeb.value) activeId.value = id; else appStore.current_history_id = id
    input.value = isWeb.value ? client.get(id)?.draft || '' : drafts.get(String(id)) || ''
    switching = false; onNavigate(); savePreferences()
  }
  async function create() {
    const value = await client.create(); activate(value.id); return value
  }
  async function setSource(value) {
    if (value === source.value || navigating.value) return
    navigating.value = true
    try {
      if (value === 'api') activate(appStore.current_history_id || '-1')
      else if (client.get(activeId.value)) activate(activeId.value)
      else await create()
    } catch (error) { onError(error) } finally { navigating.value = false }
  }
  async function load() {
    const prefs = await client.load(owner.value)
    if (prefs.source === 'chatgpt-web') {
      if (client.get(prefs.activeId)) activate(prefs.activeId)
      else await create()
    }
  }
  async function checkConnection(show = false) {
    if (!state.ready || connecting.value) return
    connecting.value = true
    try { connection.value = await api[show ? 'show' : 'status']({ project: client.project }) }
    catch (error) { connection.value = { message: error.message }; onError(error) }
    finally { connecting.value = false }
  }
  async function send(text, quote = '') {
    const id = activeId.value, current = client.get(id)
    const job = client.send(id, text, quote)
    // The controller validates and reserves the turn synchronously before its first save.
    if (current?.busy && current.draft === '') input.value = ''
    try { await job }
    catch (error) {
      if (isWeb.value && activeId.value === id && !input.value) input.value = current?.draft || text
      onError(error)
    }
  }
  let closing
  function close() {
    if (closing) return closing
    saveDraft(); stopDraftWatch(); stopIdWatch()
    closing = Promise.all([client.close(), preferenceSave]); return closing
  }
  return { client, state, source, isWeb, activeId, currentId, session, messages, needsResume,
    connection, connecting, navigating, activate, create, setSource, load, checkConnection, send, close }
}
