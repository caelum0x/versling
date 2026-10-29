// Versling service worker — offline support for the app shell + core verse
// index data. Ported from Shloka's sw.js pattern (same shell/network-first/
// stale-while-revalidate split), adapted to Versling's file names.
//
// Bump CACHE_VERSION whenever a cached file's content changes so old
// caches get cleaned up and clients pick up the new files.
const CACHE_VERSION = "v1";
const CACHE_NAME = `versling-${CACHE_VERSION}`;

const SHELL_URLS = [
  "/",
  "/index.html",
  "/app.js",
  "/styles.css",
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png",
  "/apple-touch-icon.png",
  "/data/surahs.json",
  "/data/index.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name !== CACHE_NAME)
            .map((name) => caches.delete(name))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // HTML navigations: network-first, so a fresh deploy (and the deep-link
  // OG/title rewrite the worker does for "/?v=surah:ayah") is seen
  // immediately when online, but a cached shell still loads when offline.
  if (req.mode === "navigate" || req.headers.get("accept")?.includes("text/html")) {
    // Only a plain, non-deep-linked request represents the real generic
    // shell. A "?v=surah:ayah" navigation gets a verse-specific rewritten
    // response from src/worker.js's HTMLRewriter (different <title>, OG
    // tags, and server-rendered #feed content per verse) - caching *that*
    // under the shared "/index.html" key would overwrite the one offline
    // fallback every other URL relies on with whichever verse was most
    // recently visited, so only the shell response is ever written there.
    const isShellRequest = !url.searchParams.has("v");
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (isShellRequest) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put("/index.html", copy));
          }
          return res;
        })
        .catch(() => caches.match("/index.html"))
    );
    return;
  }

  // Everything else (app.js, styles.css, per-surah data json, icons,
  // manifest): stale-while-revalidate — serve the cached copy instantly if
  // present, and refresh the cache in the background for next time. This is
  // what makes individual surah-N.json files (fetched on demand as the
  // feed scrolls, not precached in SHELL_URLS) become available offline
  // after the first time they're read.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
