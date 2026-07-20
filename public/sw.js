const CACHE = "open-wardrobe-shell-v3";
const IMAGE_CACHE = "wardrobe-images-v3";
const ACTIVE_CACHES = new Set([CACHE, IMAGE_CACHE]);
const MAX_IMAGE_ENTRIES = 800;
const SHELL = ["/", "/manifest.webmanifest"];

// Convex storage URL pattern — images served from the Convex cloud domain
// e.g. https://xxx.convex.cloud/api/storage/xxx
const CONVEX_STORAGE_HOST_RE = /\.convex\.cloud$/;

async function trimImages(cache) {
  const keys = await cache.keys();
  const overflow = keys.length - MAX_IMAGE_ENTRIES;
  if (overflow > 0) await Promise.all(keys.slice(0, overflow).map((request) => cache.delete(request)));
}

async function fetchAndCacheImage(request, cache) {
  const response = await fetch(request);
  const contentType = response.headers.get("content-type") || "";
  if (response.ok && !response.redirected && contentType.startsWith("image/")) {
    await cache.put(request, response.clone());
    await trimImages(cache);
  }
  return response;
}

async function cachedAsset(request, cache, event) {
  const cached = await cache.match(request);
  const update = fetch(request).then(async (response) => {
    if (response.ok && !response.redirected) await cache.put(request, response.clone());
    return response;
  });
  if (cached) {
    event.waitUntil(update.catch(() => undefined));
    return cached;
  }
  return update;
}

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(Promise.all([
    caches.keys().then((keys) => Promise.all(keys.filter((key) => !ACTIVE_CACHES.has(key)).map((key) => caches.delete(key)))),
  ]));
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET") return;

  // Cache Convex storage images (cross-origin from Convex cloud)
  const isConvexImage = CONVEX_STORAGE_HOST_RE.test(url.host) && url.pathname.startsWith("/api/storage/");
  if (isConvexImage) {
    event.respondWith(caches.open(IMAGE_CACHE).then(async (cache) => {
      const cached = await cache.match(request);
      const update = fetchAndCacheImage(request, cache);
      if (cached) {
        event.waitUntil(update.catch(() => undefined));
        return cached;
      }
      return update;
    }));
    return;
  }

  // Same-origin: skip non-GET and API routes (except old library images for compat)
  if (url.origin !== self.location.origin) return;
  const isLibraryImage = url.pathname.startsWith("/api/import/library/");
  if (url.pathname.startsWith("/api/") && !isLibraryImage) return;

  // Cache image processing + old library images
  if (url.pathname.startsWith("/_ipx/") || isLibraryImage) {
    event.respondWith(caches.open(IMAGE_CACHE).then(async (cache) => {
      const cached = await cache.match(request);
      const update = fetchAndCacheImage(request, cache);
      if (cached) {
        event.waitUntil(update.catch(() => undefined));
        return cached;
      }
      return update;
    }));
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(fetch(request).then((response) => {
      const copy = response.clone();
      caches.open(CACHE).then((cache) => cache.put(request, copy));
      return response;
    }).catch(() => caches.match(request).then((cached) => cached || caches.match("/"))));
    return;
  }
  event.respondWith(caches.open(CACHE).then((cache) => cachedAsset(request, cache, event)));
});
