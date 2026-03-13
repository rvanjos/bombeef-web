/**
 * validade-sw.js — Service Worker do ValidaStock PWA
 * Cache somente de assets estáticos.
 * API e auth ficam totalmente fora do service worker para evitar travas,
 * preflight/Authorization bloqueados e "Failed to fetch" no console.
 */

const CACHE_NAME = 'validastock-v2';
const STATIC_URLS = [
  '/validade_mobile.html',
  '/validade_manifest.json',
  'https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400&family=DM+Mono:wght@400;500&display=swap',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_URLS))
      .catch(() => {})
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

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Não intercepta API nem auth.
  // Deixa o navegador tratar normalmente para não gerar travas no fetch.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;

      return fetch(event.request)
        .then(resp => {
          if (resp && resp.status === 200 && resp.type !== 'opaque') {
            const clone = resp.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone)).catch(() => {});
          }
          return resp;
        })
        .catch(() => caches.match('/validade_mobile.html'));
    })
  );
});