/* Offline support.
 *
 * The diary is worth having on a phone precisely when there is no signal, so
 * the shell is cached on first visit and served from cache after that. Your
 * trades were never on the network anyway: they live in this browser.
 *
 * Two different policies, on purpose:
 *
 *   The shell (page, engine, icons) is cache-first, because a version that
 *   works beats a version that is current, and a new one is picked up in the
 *   background for next time.
 *
 *   The bars are network-first, because they are republished every day and a
 *   stale copy silently means missing candles on your newest trades.
 */
// Stamped by tools/build_web.py from the content of the files below. A
// fixed version meant a cache-first shell served the old page forever:
// once installed, no update could reach anyone.
const VERSION = "245fef575cc4";
const SHELL = "diary-shell-" + VERSION;
const DATA = "diary-bars-" + VERSION;

const FILES = [
  "./", "./index.html", "./engine.js", "./replay.js", "./system.js",
  "./manifest.webmanifest", "./icon.svg",
  "./icon-180.png", "./icon-192.png", "./icon-512.png",
];

self.addEventListener("install", e => {
  // One missing file must not fail the whole install and leave the app with
  // no offline support at all, so they are added one at a time.
  // Deliberately no skipWaiting here. Taking over immediately swaps the files
  // under a page that is already running on the old ones, which is how a
  // half-updated app ends up throwing. A new worker waits until the page says
  // it is ready, which it does when you press Reload. The very first install
  // has no worker to replace, so it activates at once regardless.
  e.waitUntil(caches.open(SHELL).then(c =>
    Promise.all(FILES.map(f => c.add(f).catch(() => {})))));
});

self.addEventListener("message", e => {
  if (e.data === "skip-waiting") self.skipWaiting();
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys())
      if (k !== SHELL && k !== DATA) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.includes("/bars/")) {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        if (fresh.ok) (await caches.open(DATA)).put(req, fresh.clone());
        return fresh;
      } catch {
        const hit = await caches.match(req);
        // No bars is a working diary without charts, not a broken page.
        return hit || new Response('{"bars":[]}',
          {headers: {"Content-Type": "application/json"}});
      }
    })());
    return;
  }

  e.respondWith((async () => {
    const hit = await caches.match(req, {ignoreSearch: true});
    const net = fetch(req).then(res => {
      if (res.ok) caches.open(SHELL).then(c => c.put(req, res.clone()));
      return res;
    }).catch(() => hit);
    return hit || net;
  })());
});
