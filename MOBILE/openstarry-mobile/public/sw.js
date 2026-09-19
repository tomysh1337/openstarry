const CACHE = 'openstarry-mobile-v1.3.0'
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(async cache => {
    const response = await fetch('/index.html', { cache: 'reload' })
    const html = await response.clone().text()
    await cache.put('/index.html', response)
    const manifest = await fetch('/asset-manifest.json', { cache: 'reload' }).then(response => response.json())
    const assets = Array.isArray(manifest) ? manifest.filter(value => typeof value === 'string' && value.startsWith('/assets/')) : [...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)].map(match => match[1])
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
  if (url.pathname.startsWith('/assets/') || url.pathname === '/OpenStarry.png') {
    event.respondWith(caches.match(event.request, { ignoreVary: true }).then(cached => cached || fetch(event.request).then(response => {
      if (response.ok) { const copy = response.clone(); event.waitUntil(caches.open(CACHE).then(cache => cache.put(event.request, copy))) }
      return response
    })))
  } else if (event.request.mode === 'navigate') event.respondWith(fetch(event.request).catch(() => caches.match('/index.html')))
})
