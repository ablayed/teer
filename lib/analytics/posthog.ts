import posthog from 'posthog-js';

let initialized = false;

export function initPostHog() {
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;

  if (initialized || !key) {
    return;
  }

  posthog.init(key, {
    api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com',
    capture_pageview: true,
  });
  initialized = true;
}
