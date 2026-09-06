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
const VERSION = "e5e080fececd";
const SHELL = "diary-shell-" + VERSION;
const DATA = "diary-bars-" + VERSION;

const FILES = [
  "./", "./index.html", "./engine.js", "./replay.js", "./system.js", "./levels.js", "./lock.js", "./demo.js", "./revisit.js", "./dashboard.js", "./chart.js", "./watchlist.js", "./series.js", "./videos.js", "./diary.js", "./clock.js", "./vault.js",
  "./seed.json",
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

  // Network first, cache as the fallback.
  //
  // Cache-first looks right for a shell and is a trap when the files are
  // published through a CDN: the worker installs the moment the new sw.js
  // arrives, which can be before index.html has propagated, and it then
  // caches the OLD page under the NEW version's name. That mixture is sticky,
  // because nothing will change the cache name again until the next build.
  // It happened, and the page it produced ran a new worker over an old page.
  //
  // The shell is under 150 KB, so preferring the network costs little and is
  // worth the guarantee. Offline still works: the cache answers whenever the
  // network cannot, and everything was precached on install.
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok) caches.open(SHELL).then(c => c.put(req, res.clone()));
      return res;
    } catch {
      const hit = await caches.match(req, {ignoreSearch: true});
      if (hit) return hit;
      throw new Error("offline and not cached");
    }
  })());
});
