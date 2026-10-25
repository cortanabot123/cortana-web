const CACHE_NAME = "cortana-web-shell-__CORTANA_BUILD_ID__"
const SHELL_ASSETS = __CORTANA_WEB_SHELL_ASSETS__

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener("message", (event) => {
  if (event.data?.type !== "SKIP_WAITING") return
  event.waitUntil(self.skipWaiting())
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => (key.startsWith("cortana-web-shell-") || key.startsWith("cortana-shell-")) && key !== CACHE_NAME).map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener("fetch", (event) => {
  const request = event.request
  const url = new URL(request.url)
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() =>
        caches.open(CACHE_NAME).then((cache) => cache.match("/index.html")),
      ),
    )
    return
  }
  event.respondWith(
    caches.open(CACHE_NAME)
      .then((cache) => cache.match(request))
      .then((cached) => cached || fetch(request)),
  )
})
