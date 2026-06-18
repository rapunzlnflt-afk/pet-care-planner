const CACHE_NAME = 'pet-care-planner-97';const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ---- v3.6.0: notification click + periodic reminder check ----
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || './index.html';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      for (const c of clients) {
        if ('focus' in c) { c.postMessage({ type: 'pawfolio-open', url: target }); return c.focus(); }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});

// Best-effort background reminder check on installed PWAs that support Periodic Background Sync.
self.addEventListener('periodicsync', event => {
  if (event.tag === 'pawfolio-reminder-check') {
    event.waitUntil(
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
        // Wake any open client to run its due-check; if none, the page-side visibility
        // handler will catch up the next time the app is opened.
        clients.forEach(c => c.postMessage({ type: 'pawfolio-reminder-check' }));
      })
    );
  }
});

// ---- v3.8.0: Web Push (server-based phone reminders) ----
// Payload shape sent by the send-pet-reminders Edge Function:
//   { title, body, tag, url, source, sourceId }
self.addEventListener('push', event => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (_) {
    payload = { title: 'Pawfolio reminder', body: event.data ? event.data.text() : '' };
  }
  const title = payload.title || 'Pawfolio reminder';
  const options = {
    body: payload.body || '',
    tag: payload.tag || ((payload.source || 'reminder') + '-' + (payload.sourceId || Date.now())),
    icon: './icon-192.png',
    badge: './icon-192.png',
    renotify: true,
    requireInteraction: true,
    data: {
      url: payload.url || './index.html',
      source: payload.source || null,
      sourceId: payload.sourceId || null
    }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Subscription rotated by the browser/push service. The page-side enable flow
// re-creates and re-registers the subscription the next time the app opens.
self.addEventListener('pushsubscriptionchange', () => {});

self.addEventListener('fetch', event => {
  // Only handle same-origin GET requests
  if (event.request.method !== 'GET') return;
  if (!event.request.url.startsWith(self.location.origin)) return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      // Return cached version, but also fetch updated version in background
      const fetchPromise = fetch(event.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => cached);

      return cached || fetchPromise;
    })
  );
});
