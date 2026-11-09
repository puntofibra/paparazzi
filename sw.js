// Red primero y sin caché del navegador: siempre la última versión; la caché solo se usa sin conexión
const CACHE = 'paparazzi-v4';
const FILES = ['./', 'index.html', 'manifest.json', 'icono-192.png'];
self.addEventListener('install', e => {
  self.skipWaiting();
  // cache:'reload' → nunca guardar una copia vieja de la caché del navegador
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(FILES.map(f => fetch(new Request(f, { cache: 'reload' })).then(r => r.ok && c.put(f, r)).catch(() => {})))));
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    // borra TODAS las cachés antiguas (versiones viejas del juego)
    const ks = await caches.keys();
    await Promise.all(ks.filter(k => k !== CACHE && k !== 'pz-gd').map(k => caches.delete(k)));
    await self.clients.claim();
    // si había alguna pestaña abierta con una versión vieja, la recargamos con la nueva
    if (ks.some(k => k !== CACHE && k !== 'pz-gd')){
      const cs = await self.clients.matchAll({ type: 'window' });
      cs.forEach(c => { try{ c.navigate(c.url); }catch(err){} });
    }
  })());
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  if (u.pathname.endsWith('version.json') || u.pathname.endsWith('sw.js')) return;
  e.respondWith(fetch(e.request, { cache: 'no-store' }).then(r => { if (r.ok && !u.search){ const cp = r.clone(); caches.open(CACHE).then(c => c.put(e.request, cp)); } return r; }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
