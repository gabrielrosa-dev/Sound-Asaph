"use strict";

const CACHE_NAME = "sound-asaph-shell-v3";
const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./drive-config.js",
  "./manifest.webmanifest",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./data/songs.json",
  "./data/folder-songs.json",
];
const SHELL_URLS = new Set(SHELL_ASSETS.map(asset => new URL(asset, self.location.href).href));

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key.startsWith("sound-asaph-shell-") && key !== CACHE_NAME)
        .map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const request = event.request;
  const requestUrl = new URL(request.url);
  if (request.method !== "GET" || requestUrl.origin !== self.location.origin ||
      requestUrl.pathname.includes("/api/")) return;

  const isNavigation = request.mode === "navigate";
  if (!isNavigation && !SHELL_URLS.has(requestUrl.href)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    if (!isNavigation) {
      try {
        const response = await fetch(request);
        if (response.ok) await cache.put(request, response.clone());
        return response;
      } catch (error) {
        const cached = await cache.match(request);
        if (cached) return cached;
        throw error;
      }
    }

    try {
      const response = await fetch(request);
      if (response.ok) await cache.put(request, response.clone());
      return response;
    } catch (error) {
      const cached = await cache.match(request) || await cache.match("./index.html");
      if (cached) return cached;
      throw error;
    }
  })());
});
