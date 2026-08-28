const CACHE_NAME = "xiaoyang-workbench-v22";
const APP_FILES = [
  "./",
  "./index.html",
  "./styles.css?v=22",
  "./theme-mobile.css?v=22",
  "./app-core.js?v=22",
  "./app-ui.js?v=22",
  "./assets/header-hero-hd.png",
  "./assets/mountain-horizon.png",
  "./assets/garden-island.png",
  "./manifest.webmanifest"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_FILES)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});
