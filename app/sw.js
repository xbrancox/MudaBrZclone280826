/* ============================================================
   MudaBrasil APP — Service Worker
   ------------------------------------------------------------
   Estratégia (lição da v1–v3: cache-first na navegação prendia
   o usuário em código velho para sempre — nem F5 nem ?reset=1
   escapavam, porque o SW servia o index cacheado ignorando a
   query string):
   - HTML, app.js, app.css → NETWORK-FIRST (revalida a cada carga;
     offline cai no cache). Código novo chega na 1ª recarga.
   - ícones/manifest/config → CACHE-FIRST (estáveis).
   - Dados (/api/*) SEMPRE rede — o app mostra a última apuração
     com "atualizado às HH:MM" quando offline.
   Bump de versão: mude CACHE e os caches antigos são apagados.
   ============================================================ */
const CACHE = 'mb-app-shell-v12';
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

/* arquivos que precisam estar sempre atualizados */
function sempreFresco(url) {
  return url.pathname === '/app/' || url.pathname === '/app/index.html' ||
         url.pathname === '/app/app.js' || url.pathname === '/app/app.css';
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                      // POST /api/voto/cargo etc. → rede
  const url = new URL(req.url);
  if (url.pathname.startsWith('/api/')) return;          // dados: sempre rede

  const navegacao = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');

  if (navegacao || sempreFresco(url)) {
    /* network-first: tenta a rede (sem cache HTTP velho), cache é só o plano B offline */
    e.respondWith(
      fetch(new Request(req, { cache: 'no-cache' })).then(r => {
        if (r.ok && url.origin === location.origin) {
          const cp = r.clone();
          caches.open(CACHE).then(c => c.put(req, cp));
        }
        return r;
      }).catch(() =>
        caches.match(req).then(hit => hit || (navegacao ? caches.match('./index.html') : hit))
      )
    );
    return;
  }

  // ícones, manifest, config: cache-first + preenche cache
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
