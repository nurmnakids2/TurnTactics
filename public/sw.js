// Turn Tactics service worker. Scope: the folder this file is served from.
// - Network first for the app's own static files, so a new deploy is picked up on the next load and
//   an old copy can never be pinned. The cache is only an offline fallback for the app shell.
// - Never touches cross-origin requests (Supabase API/auth/functions) and never caches them.
// - Receives generic push messages and routes notification clicks to same-origin pages only.
const VERSION = 'tt-shell-1.0.1';
const SHELL = ['./online.html', './tactics-ui.css', './theme.js', './online.js', './chat.js', './ui.js', './crest.js', './account.js',
  './notify.js', './rules-desk.js', './online-config.js', './push-config.js', './online.webmanifest', './icons/icon.svg', './icons/icon-192.png'];

self.addEventListener('install', (event) => {
  // Best effort: a missing optional file must not block installation.
  event.waitUntil(caches.open(VERSION).then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(new Request(url, { cache: 'reload' }))))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith('tt-shell-') && key !== VERSION).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || !url.href.startsWith(self.registration.scope)) return;
  if (request.headers.has('authorization') || request.headers.has('range')) return;
  event.respondWith((async () => {
    const cache = await caches.open(VERSION), key = url.origin + url.pathname; // version query strings share one entry
    try {
      const fresh = await fetch(request, { cache: 'no-cache' });
      if (fresh.ok && fresh.type === 'basic' && !/no-store|private/i.test(fresh.headers.get('cache-control') || '')) cache.put(key, fresh.clone());
      return fresh;
    } catch {
      const cached = await cache.match(key) || (request.mode === 'navigate' ? await cache.match(new URL('./online.html', self.registration.scope).href) : null);
      return cached || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
    }
  })());
});

// Same-origin, inside this app's folder, nothing else. Falls back to the app's entry page.
function safeUrl(candidate) {
  const home = new URL('./online.html', self.registration.scope);
  try {
    const url = new URL(typeof candidate === 'string' ? candidate : './online.html', self.registration.scope);
    return url.origin === self.location.origin && url.href.startsWith(self.registration.scope) ? url.href : home.href;
  } catch { return home.href; }
}

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* malformed payload: show the generic text */ }
  // Text is generic by design; anything unexpected in the payload is ignored rather than displayed.
  const body = typeof data.body === 'string' && /^You have (a new update|\d{1,4} new updates)\.$/.test(data.body) ? data.body : 'You have a new update.';
  event.waitUntil(self.registration.showNotification('Turn Tactics', {
    body, tag: 'turn-tactics', renotify: true, icon: './icons/icon-192.png', badge: './icons/badge-96.png', data: { url: safeUrl(data.url) },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = safeUrl(event.notification.data && event.notification.data.url);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = windows.find((client) => client.url.startsWith(self.registration.scope));
    if (open) { open.postMessage({ type: 'tt-open', url: target }); return open.focus(); }
    return self.clients.openWindow(target);
  })());
});

// The browser replaced the push subscription: ask an open page to register the new one.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(self.clients.matchAll({ type: 'window' }).then((windows) => windows.forEach((client) => client.postMessage({ type: 'tt-resubscribe' }))));
});
