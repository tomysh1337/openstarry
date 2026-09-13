import { defineStore } from 'pinia'
import { ref } from 'vue'

const LOCAL_USER = Object.freeze({
  username: '本地用户',
  user_uid: 'local-user'
})

export const useAuthStore = defineStore('auth', () => {
  const loading = ref(false)
  const user = ref({ ...LOCAL_USER })

  const restore = () => {
    user.value = { ...LOCAL_USER }
    return user.value
  }
  const persist = () => restore()
  const login = async () => true
  const register = async () => true
  const ensure = async () => true
  const logout = () => restore()

  return { loading, user, login, register, restore, persist, logout, ensure }
})
