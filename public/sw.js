// Service worker: makes Three-Eight installable as an app and lets the page itself open without a connection.
// Network first: the server revalidates every file (Cache-Control: no-cache), so updates show up on the next load,
// and the cache is used only when the network fails. Calls, signaling, the API and Drive movies are never touched.
const CACHE = 'three-eight-shell-v2'; // v2: drops a shell that v1 may have replaced with /healthz
// Every room path serves the same index.html: keep one copy of it, under "/".
const SHELL_KEY = '/';
// Paths that are not rooms (server/store.js RESERVED).
const RESERVED = /^\/(admin|assets|api|ws|healthz)\/?$/i;

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  let key;
  if (req.mode === 'navigate') {
    // "/" and "/<ROOM>" (the admin page and the server's other reserved paths, such as /healthz, are left alone)
    if (!/^\/([A-Za-z0-9][A-Za-z0-9_-]{0,63}\/?)?$/.test(url.pathname) || RESERVED.test(url.pathname)) return;
    key = SHELL_KEY;
  } else if (url.pathname.startsWith('/assets/') || url.pathname === '/manifest.webmanifest') {
    key = url.pathname;
  } else {
    return;
  }
  event.respondWith(networkFirst(req, key));
});

async function networkFirst(req, key) {
  try {
    const res = await fetch(req);
    // Only the page itself may stand in for "/": anything else (a plain-text answer, say) would break offline loads.
    const html = key !== SHELL_KEY || /^text\/html\b/i.test(res.headers.get('content-type') || '');
    if (res.ok && !res.redirected && res.type === 'basic' && html) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(key, copy)).catch(() => {});
    }
    return res;
  } catch (err) {
    const hit = await caches.match(key, { cacheName: CACHE });
    if (hit) return hit;
    throw err;
  }
}
