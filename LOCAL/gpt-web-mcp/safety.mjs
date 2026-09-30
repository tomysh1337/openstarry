import { readFileSync } from 'node:fs'
import { problem } from './store.mjs'

export const safetyModes = ['ask', 'auto', 'full']
export function safetyPolicy({ settingsPath, newFilePolicy }) {
  return () => {
    let settings = {}
    if (settingsPath) {
      try { settings = JSON.parse(readFileSync(settingsPath, 'utf8')) }
      catch (error) { if (error.code !== 'ENOENT') throw problem('POLICY_UNAVAILABLE', 'Local approval settings need repair', 503) }
    }
    const mode = settings.safetyMode || ((settings.newFilePolicy || newFilePolicy) === 'direct' ? 'auto' : 'ask')
    if (!safetyModes.includes(mode)) throw problem('POLICY_UNAVAILABLE', 'Unknown local approval mode', 503)
    return { safetyMode: mode, newFilePolicy: mode === 'ask' ? 'review' : 'direct', existingFileReviewRequired: mode !== 'full' }
  }
}
