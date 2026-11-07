const CACHE_NAME = 'al-nadam-store-v3';
const OFFLINE_URL = './offline.html';
const MAIN_PAGE_URL = './index.html';

const CORE_ASSETS = [
    MAIN_PAGE_URL,
    OFFLINE_URL,
    '/falcon-logo.svg',
    '/favicon.svg',
    'https://fonts.googleapis.com/css2?family=Cairo:wght@300;400;500;600;700;800;900&display=swap',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css'
];

self.addEventListener('install', event => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE_NAME);
        await Promise.allSettled(CORE_ASSETS.map(async asset => {
            try {
                await cache.add(asset);
            } catch (error) {
                console.warn('[SW] Asset cache skipped:', asset, error);
            }
        }));
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const cacheNames = await caches.keys();
        await Promise.all(
            cacheNames
                .filter(name => name.startsWith('al-nadam-store-') && name !== CACHE_NAME)
                .map(name => caches.delete(name))
        );
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', event => {
    const request = event.request;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);

    if (request.mode === 'navigate') {
        event.respondWith((async () => {
            try {
                const networkResponse = await fetch(request);
                if (networkResponse.ok) {
                    const cache = await caches.open(CACHE_NAME);
                    await cache.put(request, networkResponse.clone());
                }
                return networkResponse;
            } catch (error) {
                const cache = await caches.open(CACHE_NAME);
                const cachedPage = await cache.match(request);
                if (cachedPage) return cachedPage;
                return cache.match(OFFLINE_URL);
            }
        })());
        return;
    }

    if (url.origin === self.location.origin) {
        event.respondWith((async () => {
            const cached = await caches.match(request);
            if (cached) return cached;
            const networkResponse = await fetch(request);
            if (networkResponse.ok) {
                const cache = await caches.open(CACHE_NAME);
                await cache.put(request, networkResponse.clone());
            }
            return networkResponse;
        })());
        return;
    }

    const cachedAsset = new Set([
        'fonts.googleapis.com',
        'fonts.gstatic.com',
        'cdnjs.cloudflare.com'
    ]);

    if (cachedAsset.has(url.hostname)) {
        event.respondWith((async () => {
            const cache = await caches.open(CACHE_NAME);
            const cached = await cache.match(request);
            if (cached) return cached;
            try {
                const response = await fetch(request);
                if (response.ok) await cache.put(request, response.clone());
                return response;
            } catch (error) {
                return new Response('', {
                    status: 503,
                    statusText: 'Offline'
                });
            }
        })());
    }
});
