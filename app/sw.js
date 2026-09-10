/* ============================================================
   MudaBrasil APP — Service Worker v1
   ------------------------------------------------------------
   Cache só do SHELL (app/index.html, manifest, config, ícones).
   Dados (/api/*) SEMPRE vêm da rede — o app JS mostra a última
   apuração com "última atualização HH:MM" quando offline.
   Bump de versão: mude CACHE e o shell é re-baixado no activate.
   ============================================================ */
const CACHE = 'mb-app-shell-v1';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  '../config.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                      // POST /api/voto/cargo etc. → rede
  const url = new URL(req.url);
  if (url.pathname.startsWith('/api/')) return;          // dados: sempre rede

  // Navegação: shell cache-first; offline cai no index cached
  if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
    e.respondWith(
      caches.match('./index.html').then(hit =>
        hit || fetch(req).then(r => { const cp = r.clone(); caches.open(CACHE).then(c => c.put('./index.html', cp)); return r; })
      ).catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Demais assets do shell: cache-first + preenche cache
  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(r => {
      if (r.ok && (url.origin === location.origin)) {
        const cp = r.clone();
        caches.open(CACHE).then(c => c.put(req, cp));
      }
      return r;
    }))
  );
});
