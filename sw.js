const CACHE_PREFIX = "xiaoyang-workbench-";
const CACHE_NAME = `${CACHE_PREFIX}v47`;
const APP_FILES = [
  "./",
  "./index.html",
  "./styles.css?v=47",
  "./theme-mobile.css?v=47",
  "./app-core.js?v=47",
  "./app-ui.js?v=47",
  "./assets/hero-v47.webp",
  "./assets/meditation-v47.webp",
  "./assets/standing-v47.webp",
  "./assets/reading-v47.webp",
  "./assets/walking-v47.webp",
  "./assets/focus-v47.webp",
  "./assets/baduanjin-v47.webp",
  "./assets/running-v47.webp",
  "./assets/paper-v43.webp",
  "./assets/app-icon-v46-192.png",
  "./assets/app-icon-v46-512.png",
  "./assets/apple-touch-icon-v46.png",
  "./assets/favicon-v46-32.png",
  "./manifest.webmanifest?v=47"
];

async function matchAppCache(key) {
  const names = (await caches.keys()).filter((name) => name.startsWith(CACHE_PREFIX));
  names.sort((a, b) => (a === CACHE_NAME ? -1 : b === CACHE_NAME ? 1 : b.localeCompare(a)));
  for (const name of names) {
    const cached = await (await caches.open(name)).match(key);
    if (cached) return cached;
  }
  return null;
}

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(
    APP_FILES.map((file) => new Request(new URL(file, self.registration.scope), { cache: "reload" }))
  )));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) return;
  if (!requestUrl.pathname.startsWith(new URL(self.registration.scope).pathname)) return;

  // 手动刷新探测必须真实到达服务器，不能把离线回退误判为新版。
  if (requestUrl.searchParams.has("__workbench_refresh")) {
    event.respondWith(fetch(event.request, { cache: "no-store" }));
    return;
  }

  // HTML 的刷新参数只用于联网更新，不为每次刷新累积一份离线副本。
  const cacheKey = event.request.mode === "navigate"
    ? new URL("index.html", self.registration.scope).href
    : event.request;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  let writeToCache = Promise.resolve();
  const responsePromise = (async () => {
    try {
      // 图片文件随版本改名；重复打开时直接用缓存，不再等待网络。
      const assetPath = new URL("assets/", self.registration.scope).pathname;
      if (requestUrl.pathname.startsWith(assetPath) && /\.(?:webp|png|svg)$/i.test(requestUrl.pathname)) {
        const cached = await matchAppCache(cacheKey);
        if (cached) return cached;
      }
      const response = await fetch(event.request, { cache: "no-cache", signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const copy = response.clone();
      writeToCache = caches.open(CACHE_NAME).then((cache) => cache.put(cacheKey, copy)).catch(() => {});
      return response;
    } catch {
      // 刷新预取的资源可在网络突然中断时接力；只查询本应用的缓存。
      return (await matchAppCache(cacheKey)) || Response.error();
    } finally {
      clearTimeout(timeout);
    }
  })();
  event.respondWith(responsePromise);
  event.waitUntil(responsePromise.then(() => writeToCache));
});
