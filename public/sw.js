// Service Worker for mixBase PWA
// Caches static assets only. HTML documents are never cached: every page is
// auth-gated and server-rendered, so caching them serves stale or
// logged-out/redirect content (the old APP_SHELL pre-cache did exactly that).

const CACHE_NAME = 'mixbase-v3';

self.addEventListener('install', () => {
  self.skipWaiting();
});

// Activate: clean up old caches (purges the poisoned v2 HTML entries)
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: network-only for documents/API, network-first with cache fallback for
// static assets (icons, fonts, _next/static, images).
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/')) return;
  if (url.hostname.includes('supabase')) return;
  // Never intercept or cache HTML navigations — they depend on auth cookies.
  if (event.request.mode === 'navigate' || event.request.destination === 'document') return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
