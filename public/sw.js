const CACHE_NAME = "koraput-map-v1";
const ASSETS = [
  "/",
  "/index.html",
  "/app.js",
  "/satyam.png",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    })
  );
});

self.addEventListener("fetch", (event) => {
  // APIs aur Socket.io ko cache nahi karna hai
  if (event.request.url.includes('/socket.io/') || event.request.url.includes('api.')) {
      return;
  }
  
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      return cachedResponse || fetch(event.request);
    })
  );
});
