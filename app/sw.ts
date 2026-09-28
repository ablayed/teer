const CACHE_VERSION = 'teer-sw-v3';
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const CURRENT_CACHES = [SHELL_CACHE, STATIC_CACHE] as const;
const shellAssets = ['/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

type InstallEvent = Event & {
  waitUntil(promise: Promise<unknown>): void;
};

type ActivateEvent = Event & {
  waitUntil(promise: Promise<unknown>): void;
};

type FetchEvent = Event & {
  request: Request;
  respondWith(response: Promise<Response> | Response): void;
};

type NavigationPreloadManager = {
  disable(): Promise<void>;
};

type WorkerRegistration = {
  navigationPreload?: NavigationPreloadManager;
};

const scope = globalThis as unknown as {
  addEventListener(type: 'install', listener: (event: InstallEvent) => void): void;
  addEventListener(type: 'activate', listener: (event: ActivateEvent) => void): void;
  addEventListener(type: 'fetch', listener: (event: FetchEvent) => void): void;
  caches: CacheStorage;
  clients: {
    claim(): Promise<void>;
  };
  fetch: typeof fetch;
  location: {
    origin: string;
  };
  registration: WorkerRegistration;
  skipWaiting(): Promise<void>;
};

scope.addEventListener('install', (event) => {
  event.waitUntil(
    scope.caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(shellAssets))
      .then(() => scope.skipWaiting()),
  );
});

scope.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Navigation Preload DÉSACTIVÉ, et explicitement : l'état vit sur l'inscription et survit
      // au remplacement du script, retirer `enable()` ne suffirait pas. Actif, il part au niveau
      // de la navigation, y compris vers /api/** que ce worker rend au navigateur : celui-ci jette
      // la réponse preload et refait la requête → code OAuth, state et intention envoyés deux
      // fois (FIX-SW-NAVIGATION-PRELOAD-01, tests/e2e/service-worker-navigation-preload.spec.ts).
      if (scope.registration.navigationPreload) {
        await scope.registration.navigationPreload.disable();
      }

      const cacheNames = await scope.caches.keys();

      await Promise.all(
        cacheNames
          .filter(
            (cacheName) => !CURRENT_CACHES.includes(cacheName as (typeof CURRENT_CACHES)[number]),
          )
          .map((cacheName) => scope.caches.delete(cacheName)),
      );

      await scope.clients.claim();
    })(),
  );
});

scope.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') {
    return;
  }

  // Ne JAMAIS intercepter les routes /api/** : elles redirigent cross-origin (OAuth Shopify) et
  // posent des cookies (état OAuth), et portent des valeurs à usage unique → on laisse le
  // navigateur les gérer nativement. Ne rien retourner ici n'est sûr QUE parce que le
  // Navigation Preload est désactivé (voir `activate`).
  const url = new URL(event.request.url);
  if (url.origin === scope.location.origin && url.pathname.startsWith('/api/')) {
    return;
  }

  event.respondWith(handleRequest(event));
});

async function handleRequest(event: FetchEvent): Promise<Response> {
  const { request } = event;
  const url = new URL(request.url);

  if (request.mode === 'navigate') {
    return handleNavigationRequest(event);
  }

  if (url.origin === scope.location.origin) {
    if (shellAssets.includes(url.pathname)) {
      return cacheFirst(request, SHELL_CACHE);
    }

    if (url.pathname.startsWith('/_next/static/')) {
      return cacheFirst(request, STATIC_CACHE);
    }
  }

  return fetchWithCacheFallback(request);
}

async function handleNavigationRequest(event: FetchEvent): Promise<Response> {
  try {
    return await scope.fetch(event.request);
  } catch {
    const cachedResponse = await scope.caches.match(event.request);

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

async function cacheFirst(request: Request, cacheName: string): Promise<Response> {
  const cachedResponse = await scope.caches.match(request);

  if (cachedResponse) {
    return cachedResponse;
  }

  try {
    const response = await scope.fetch(request);

    if (response.ok) {
      const cache = await scope.caches.open(cacheName);
      await cache.put(request, response.clone());
    }

    return response;
  } catch {
    return (
      (await scope.caches.match(request)) ||
      new Response('Ressource indisponible hors ligne.', {
        status: 503,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
        },
      })
    );
  }
}

async function fetchWithCacheFallback(request: Request): Promise<Response> {
  try {
    return await scope.fetch(request);
  } catch {
    return (
      (await scope.caches.match(request)) ||
      new Response('Ressource réseau indisponible.', {
        status: 503,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
        },
      })
    );
  }
}

export {};
