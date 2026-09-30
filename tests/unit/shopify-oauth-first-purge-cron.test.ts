// SHOPIFY-OAUTH-FIRST-01 / B8 — purge des installations en attente, branchée sur le cron
// `shopify-pcd-retention`. Couche : unitaire (route réelle, bords remplacés). Le périmètre exact
// de la purge est prouvé contre la base dans tests/rls/shopify-oauth-first-01.rls.test.ts.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  rpcCalls: [] as string[],
  purgeResult: { data: 3, error: null } as { data: unknown; error: { code: string } | null },
  logs: [] as unknown[][],
}));

vi.mock('@/lib/shopify/pcd-retention', () => ({
  DEFAULT_PCD_RETENTION_BATCH: 100,
  MAX_PCD_RETENTION_BATCH: 500,
  executeShopifyPcdRetention: vi.fn(async () => ({ mode: 'execute', processed: 0 })),
  previewShopifyPcdRetention: vi.fn(async () => ({ candidates: 0 })),
}));
vi.mock('@/lib/supabase/protected-client', () => ({
  createProtectedSupabaseClient: () => ({
    rpc: async (name: string) => {
      harness.rpcCalls.push(name);
      return harness.purgeResult;
    },
  }),
}));

const CRON_SECRET = crypto.randomUUID();

async function callCron(mode: string) {
  const { GET } = await import('@/app/api/cron/shopify-pcd-retention/route');
  return GET(
    new Request(`http://localhost/api/cron/shopify-pcd-retention?mode=${mode}`, {
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    }),
  );
}

beforeEach(() => {
  vi.stubEnv('CRON_SECRET', CRON_SECRET);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://127.0.0.1:54321');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-placeholder');
  harness.rpcCalls = [];
  harness.purgeResult = { data: 3, error: null };
  harness.logs = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    harness.logs.push(args);
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    harness.logs.push(args);
  });
});

describe('B8 — purge sur le cron existant', () => {
  it('mode execute : purge appelée, compte seul journalisé', async () => {
    const response = await callCron('execute');
    expect(response.status).toBe(200);
    expect(harness.rpcCalls).toEqual(['purge_expired_shopify_pending_installations']);
    expect(harness.logs).toEqual([
      ['[shopify-pcd-retention] pending installations purged', { count: 3 }],
    ]);
  });

  it('mode dry-run : aucune purge', async () => {
    const response = await callCron('dry-run');
    expect(response.status).toBe(200);
    expect(harness.rpcCalls).toEqual([]);
  });

  it('échec de la purge : journalisé (code seul), la rétention reste un succès', async () => {
    harness.purgeResult = { data: null, error: { code: '42501' } };
    const response = await callCron('execute');
    expect(response.status).toBe(200);
    expect(harness.logs).toEqual([
      ['[shopify-pcd-retention] pending installations purge failed', { code: '42501' }],
    ]);
  });
});
