/* 2 Fold service worker.
   - App shell only: static build assets are cached. API calls, Supabase traffic, signed URLs and any
     authenticated response are NEVER cached (network-only), so private data cannot leak via the cache.
   - Web Push: shows message/call notifications, suppressed when the app is already visible (no duplicates).
   - Notification click: focuses/open the right screen. */
const VERSION = 'v1'
const SHELL = `2fold-shell-${VERSION}`

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(['/', '/manifest.webmanifest', '/favicon.svg'])))
})
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('2fold-') && k !== SHELL) await caches.delete(k)
    await self.clients.claim()
  })())
})
self.addEventListener('message', (e) => { if (e.data === 'SKIP_WAITING') self.skipWaiting() })

self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url)
  if (req.method !== 'GET' || url.origin !== self.location.origin) return          // never touch cross-origin (Supabase, TURN, fonts)
  if (req.mode === 'navigate') {                                                   // network first, offline fallback to shell
    e.respondWith(fetch(req).catch(() => caches.match('/')))
    return
  }
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) { // hashed static files: cache-first
    e.respondWith(caches.open(SHELL).then(async (c) => {
      const hit = await c.match(req); if (hit) return hit
      const res = await fetch(req); if (res.ok) c.put(req, res.clone()); return res
    }))
  }
})

self.addEventListener('push', (e) => {
  let d = {}
  try { d = e.data ? e.data.json() : {} } catch { /* ignore */ }
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const visible = wins.some((w) => w.visibilityState === 'visible')
    if (visible && d.kind === 'message') return          // app is open: the UI already shows it
    if (visible && d.kind === 'call') { wins.forEach((w) => w.postMessage({ type: 'incoming-call-push' })); return }
    await self.registration.showNotification(d.title || '2 Fold 💕', {
      body: d.body || '', tag: d.tag || 'general', renotify: false, requireInteraction: !!d.requireInteraction,
      icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', vibrate: d.kind === 'call' ? [300, 150, 300, 150, 300] : [100],
      data: { url: d.url || '/' },
    })
  })())
})

self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const target = new URL(e.notification.data?.url || '/', self.location.origin).href
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const w of wins) { if ('focus' in w) { await w.focus(); if ('navigate' in w) await w.navigate(target); return } }
    await self.clients.openWindow(target)
  })())
})
