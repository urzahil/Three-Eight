// Service worker: makes Three-Eight installable as an app and lets the page itself open without a connection.
// Network first: the server revalidates every file (Cache-Control: no-cache), so updates show up on the next load,
// and the cache is used only when the network fails. Calls, signaling, the API and Drive movies are never touched.
const CACHE = 'three-eight-shell-v1';
// Every room path serves the same index.html: keep one copy of it, under "/".
const SHELL_KEY = '/';

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
    // "/" and "/<ROOM>" (the admin page is left alone)
    if (!/^\/([A-Za-z0-9][A-Za-z0-9_-]{0,63}\/?)?$/.test(url.pathname) || /^\/admin\/?$/.test(url.pathname)) return;
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
    if (res.ok && !res.redirected && res.type === 'basic') {
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
