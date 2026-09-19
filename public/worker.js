// Kill switch for the legacy site's service worker. Browsers that visited the old PHP site still have
// /worker.js registered and re-fetch it on their update check; this version replaces it, unregisters itself and
// reloads open tabs so they pick up the current offline worker (/sw.js, registered by js/pgindex.js).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(
    self.registration
      .unregister()
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then((clients) => clients.forEach((client) => client.navigate(client.url)))
  );
});
