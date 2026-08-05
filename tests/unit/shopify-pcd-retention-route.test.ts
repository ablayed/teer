import { GET } from '@/app/api/cron/shopify-pcd-retention/route';
import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('GET /api/cron/shopify-pcd-retention', () => {
  beforeEach(() => {
    vi.stubEnv('CRON_SECRET', '');
  });

  it('refuse par défaut si CRON_SECRET est absent', async () => {
    const response = await GET(new Request('http://localhost/api/cron/shopify-pcd-retention'));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthorized' });
  });
});
