'use strict';
const VERSION = 'v1';                       // bei größeren Änderungen hochzählen
const CORE_CACHE = `vokabeltrainer-core-${VERSION}`;
const RUNTIME_CACHE = `vokabeltrainer-runtime-${VERSION}`;
const CORE_ASSETS = ['./', 'index.html', 'app.js', 'manifest.json', 'icons/icon-192.png', 'icons/icon-512.png'];
const CDN_HOSTS = ['cdn.jsdelivr.net'];     // Tesseract, Supabase-Script, Wortlisten

self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(CORE_CACHE);
        // einzeln, damit ein fehlendes Icon nicht die ganze Installation verhindert
        await Promise.all(CORE_ASSETS.map((url) => cache.add(url).catch(() => {})));
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const keep = [CORE_CACHE, RUNTIME_CACHE];
        const names = await caches.keys();
        await Promise.all(names.filter((n) => n.startsWith('vokabeltrainer-') && !keep.includes(n)).map((n) => caches.delete(n)));
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);

    // Eigene Dateien: erst Netz (immer aktuell), offline aus dem Cache
    if (url.origin === location.origin) {
        event.respondWith((async () => {
            try {
                const res = await fetch(req);
                if (res.ok) (await caches.open(CORE_CACHE)).put(req, res.clone());
                return res;
            } catch (err) {
                const cached = await caches.match(req, { ignoreSearch: true });
                if (cached) return cached;
                if (req.mode === 'navigate') return (await caches.match('index.html')) || (await caches.match('./'));
                throw err;
            }
        })());
        return;
    }

    // CDN-Dateien (Bibliotheken, Wortlisten): Cache zuerst. Die jsDelivr-API wird nicht gecacht.
    if (CDN_HOSTS.includes(url.hostname)) {
        event.respondWith((async () => {
            const cached = await caches.match(req);
            if (cached) return cached;
            const res = await fetch(req);
            if (res.ok || res.type === 'opaque') (await caches.open(RUNTIME_CACHE)).put(req, res.clone());
            return res;
        })());
    }
    // alles andere (z. B. supabase.co) läuft ungecacht direkt ins Netz
});

/* ---------- Push-Vorbereitung ---------- */
self.addEventListener('push', (event) => {
    let data = {};
    try { data = event.data ? event.data.json() : {}; } catch (e) { data = { body: event.data ? event.data.text() : '' }; }
    event.waitUntil(self.registration.showNotification(data.title || 'Vokabeltrainer', {
        body: data.body || 'Zeit zum Üben! 📚',
        icon: 'icons/icon-192.png',
        badge: 'icons/icon-192.png',
        tag: data.tag || 'daily-practice',
        data: { url: data.url || './' }
    }));
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const target = new URL((event.notification.data && event.notification.data.url) || './', self.registration.scope).href;
    event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
        for (const c of list) if (c.url.startsWith(self.registration.scope) && 'focus' in c) return c.focus();
        return self.clients.openWindow(target);
    }));
});

self.addEventListener('message', (event) => { if (event.data === 'SKIP_WAITING') self.skipWaiting(); });
