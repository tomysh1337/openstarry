const pairing = document.querySelector('#pairing'), status = document.querySelector('#status')
const connect = document.querySelector('#connect'), disconnect = document.querySelector('#disconnect')
async function refresh() {
  const value = await chrome.storage.session.get('status')
  status.textContent = value.status || '尚未配对'
}
connect.addEventListener('click', async () => {
  connect.disabled = true
  try {
    const response = await chrome.runtime.sendMessage({ type: 'connect', code: pairing.value })
    if (response.error) throw Error(response.error.message)
    pairing.value = ''
    await refresh()
  } catch (error) { status.textContent = error.message }
  finally { connect.disabled = false }
})
disconnect.addEventListener('click', async () => {
  const response = await chrome.runtime.sendMessage({ type: 'disconnect' })
  if (response.error) status.textContent = response.error.message
  else await refresh()
})
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.status) status.textContent = changes.status.newValue || '尚未配对'
})
void refresh()
