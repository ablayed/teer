const CACHE_VERSION = 'teer-sw-v2';
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const CURRENT_CACHES = [SHELL_CACHE, STATIC_CACHE];
const shellAssets = ['/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(shellAssets))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      if ('navigationPreload' in self.registration) {
        await self.registration.navigationPreload.enable();
      }

      const cacheNames = await caches.keys();

      await Promise.all(
        cacheNames
          .filter((cacheName) => !CURRENT_CACHES.includes(cacheName))
          .map((cacheName) => caches.delete(cacheName)),
      );

      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') {
    return;
  }

  event.respondWith(handleRequest(event));
});

async function handleRequest(event) {
  const { request } = event;
  const url = new URL(request.url);

  if (request.mode === 'navigate') {
    return handleNavigationRequest(event);
  }

  if (url.origin === self.location.origin) {
    if (shellAssets.includes(url.pathname)) {
      return cacheFirst(request, SHELL_CACHE);
    }

    if (url.pathname.startsWith('/_next/static/')) {
      return cacheFirst(request, STATIC_CACHE);
    }
  }

  return fetchWithCacheFallback(request);
}

async function handleNavigationRequest(event) {
  try {
    const preloadResponse = await event.preloadResponse;

    if (preloadResponse) {
      return preloadResponse;
    }

    return await fetch(event.request);
  } catch {
    const cachedResponse = await caches.match(event.request);

    if (cachedResponse) {
      return cachedResponse;
    }

    return new Response('Navigation indisponible hors ligne.', {
      status: 503,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
      },
    });
  }
}

async function cacheFirst(request, cacheName) {
  const cachedResponse = await caches.match(request);

  if (cachedResponse) {
    return cachedResponse;
  }

  try {
    const response = await fetch(request);

    if (response.ok) {
      const cache = await caches.open(cacheName);
      await cache.put(request, response.clone());
    }

    return response;
  } catch {
    return (
      (await caches.match(request)) ||
      new Response('Ressource indisponible hors ligne.', {
        status: 503,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
        },
      })
    );
  }
}

async function fetchWithCacheFallback(request) {
  try {
    return await fetch(request);
  } catch {
    return (
      (await caches.match(request)) ||
      new Response('Ressource réseau indisponible.', {
        status: 503,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
        },
      })
    );
  }
}
