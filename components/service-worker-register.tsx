'use client';

import { useEffect } from 'react';

export function ServiceWorkerRegister() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) {
      return;
    }

    if (process.env.NODE_ENV !== 'production') {
      void navigator.serviceWorker.getRegistrations().then((registrations) => {
        void Promise.all(registrations.map((registration) => registration.unregister()));
      });
      if ('caches' in window) {
        void caches.keys().then((cacheNames) => {
          void Promise.all(cacheNames.map((cacheName) => caches.delete(cacheName)));
        });
      }
      return;
    }

    void navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
  }, []);

  return null;
}
