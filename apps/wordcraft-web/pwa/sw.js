// WordCraft offline cache. Hashed build files (.js/.wasm) are cache-first; everything else
// same-origin is network-first with a cache fallback, so a new deploy shows up on next load.
const CACHE = "wordcraft-v1";
const HASHED = /-[0-9a-f]{8,}(_bg)?\.(js|wasm)$/;

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

async function prune(cache, pathname) {
  const stem = pathname.replace(HASHED, "");
  const ext = pathname.slice(pathname.lastIndexOf("."));
  for (const req of await cache.keys()) {
    const p = new URL(req.url).pathname;
    if (p !== pathname && HASHED.test(p) && p.replace(HASHED, "") === stem && p.endsWith(ext)) {
      await cache.delete(req);
    }
  }
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (HASHED.test(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok && res.status === 200) {
        await cache.put(req, res.clone());
        await prune(cache, url.pathname);
      }
      return res;
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(req);
      if (res.ok && res.status === 200) await cache.put(req, res.clone());
      return res;
    } catch (err) {
      const hit = (await cache.match(req)) || (req.mode === "navigate" ? await cache.match("./") || await cache.match("./index.html") : undefined);
      if (hit) return hit;
      throw err;
    }
  })());
});
