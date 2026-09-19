const CACHE = 'openstarry-mobile-v1.2.1'
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(async cache => {
    const response = await fetch('/index.html', { cache: 'reload' })
    const html = await response.clone().text()
    await cache.put('/index.html', response)
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)].map(match => match[1])
    await cache.addAll(['/OpenStarry.png', ...assets])
  }))
})
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('openstarry-mobile-') && key !== CACHE).map(key => caches.delete(key)))))
  self.clients.claim()
})
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || event.request.headers.has('Authorization')) return
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.match('/index.html')))
  } else if (url.pathname.startsWith('/assets/') || url.pathname === '/OpenStarry.png') {
    event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request)))
  }
})
