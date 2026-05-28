'use client';

import { initPostHog } from '@/lib/analytics/posthog';
import { useEffect } from 'react';

export function AnalyticsProvider() {
  useEffect(() => {
    initPostHog();
  }, []);

  return null;
}
