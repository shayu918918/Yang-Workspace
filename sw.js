const CACHE_NAME = "xiaoyang-workbench-v36";
const APP_FILES = [
  "./",
  "./index.html",
  "./styles.css?v=36",
  "./theme-mobile.css?v=36",
  "./app-core.js?v=36",
  "./app-ui.js?v=36",
  "./assets/header-hero-hd.png",
  "./assets/mountain-horizon.png",
  "./assets/garden-island.png",
  "./assets/xuan-paper-ui.png",
  "./assets/mountain-emblem-ui.png",
  "./assets/bamboo-cloud-ui.png",
  "./assets/stillness-lotus-ui.png",
  "./assets/running-trail-ui.png",
  "./assets/report-scroll-ui.png",
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
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) return;

  // 部署更新优先从网络读取；断网时再回退到本地缓存。
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => {
        if (cached) return cached;
        if (event.request.mode === "navigate") return caches.match("./index.html");
        return Response.error();
      }))
  );
});
