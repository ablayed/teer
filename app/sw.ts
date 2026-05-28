const cacheName = 'teer-shell-v1';
const shellAssets = ['/', '/connexion', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

type InstallEvent = Event & {
  waitUntil(promise: Promise<unknown>): void;
};

type FetchEvent = Event & {
  request: Request;
  respondWith(response: Promise<Response> | Response): void;
};

const scope = globalThis as unknown as {
  addEventListener(type: 'install', listener: (event: InstallEvent) => void): void;
  addEventListener(type: 'fetch', listener: (event: FetchEvent) => void): void;
  caches: CacheStorage;
  fetch: typeof fetch;
  skipWaiting(): Promise<void>;
};

scope.addEventListener('install', (event) => {
  event.waitUntil(
    scope.caches
      .open(cacheName)
      .then((cache) => cache.addAll(shellAssets))
      .then(() => scope.skipWaiting()),
  );
});

scope.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') {
    return;
  }

  event.respondWith(
    scope.caches.match(event.request).then((cached) => cached ?? scope.fetch(event.request)),
  );
});

export {};
