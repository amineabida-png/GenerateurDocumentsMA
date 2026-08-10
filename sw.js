// Service worker minimal : rend l'app installable et utilisable hors-ligne.
// Toutes les données (profil, documents, historique, clients) restent en
// localStorage sur l'appareil — ce worker ne fait que mettre en cache les
// fichiers statiques de l'application elle-même.
const CACHE = 'gdma-v1';
const CORE_ASSETS = [
  '/', '/index.html', '/manifest.json',
  '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png', '/apple-touch-icon.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE_ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;

  // Page principale : réseau d'abord (toujours la dernière version en ligne),
  // secours sur le cache si hors-ligne.
  if (e.request.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html') {
    e.respondWith(
      fetch(e.request)
        .then((res) => { caches.open(CACHE).then((c) => c.put(e.request, res.clone())); return res; })
        .catch(() => caches.match(e.request).then((r) => r || caches.match('/index.html')))
    );
    return;
  }

  // Manifest / icônes : cache d'abord (statiques, rarement modifiés).
  e.respondWith(caches.match(e.request).then((cached) => cached || fetch(e.request)));
});
