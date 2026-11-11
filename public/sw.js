// EMS does not use a service worker. This file exists only to remove one that another
// app left behind on the same address (for example a dev server that also ran on
// localhost:3000). Such a worker answers page requests from its own cache, so a click
// in the menu shows the previous page and only a second click seems to work.
//
// Browsers re-check a registered worker's script on every visit. When they fetch this
// version it replaces the old worker, deletes its caches, unregisters itself and
// reloads the open tabs, so every page comes straight from the server again.
self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(key => caches.delete(key)));
    await self.clients.claim();
    await self.registration.unregister();
    const windows = await self.clients.matchAll({ type: 'window' });
    await Promise.all(windows.map(client => client.navigate(client.url).catch(() => {})));
  })());
});
