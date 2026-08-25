import type { ResolvedConnectionContext } from '@/lib/ingestion/canonical';
import { linkExternalRef, writeIngestionEvent } from '@/lib/ingestion/dual-write';
import type { Database } from '@/lib/supabase/database.types';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

const CTX = {
  storeConnectionId: 'sc-1',
  merchantAccountId: 'ma-1',
  shopId: 'shop-1',
  platform: 'shopify',
  platformAppId: 'app-a',
} as unknown as ResolvedConnectionContext;

function fakeAdmin({
  insertError,
  selectResult,
}: {
  insertError?: { code: string; message: string } | null;
  selectResult?: { data: { entity_id: string } | null; error: { message: string } | null };
} = {}) {
  const admin = {
    from: (table: string) => {
      if (table === 'ingestion_event') {
        return { insert: async () => ({ error: insertError ?? null }) };
      }
      if (table === 'external_ref') {
        return {
          insert: async () => ({ error: insertError ?? null }),
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => selectResult ?? { data: null, error: null },
                }),
              }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  } as unknown as SupabaseClient<Database>;
  return admin;
}

describe('Lot L2 — dual-write', () => {
  describe('writeIngestionEvent', () => {
    it('rejeu du même événement (23505 sur le dédoublonnage) → idempotent, jamais une panne', async () => {
      const admin = fakeAdmin({ insertError: { code: '23505', message: 'dup' } });
      const result = await writeIngestionEvent(admin, {
        ctx: CTX,
        topic: 'orders/create',
        deliveryId: 'wh-1',
        resourceKind: 'order',
        resourceExternalId: '123',
        status: 'done',
        triggeredAt: null,
      });
      expect(result).toEqual({ ok: true, duplicate: true });
    });

    it('erreur non-23505 → échec explicite, pas absorbé silencieusement', async () => {
      const admin = fakeAdmin({ insertError: { code: '42501', message: 'permission denied' } });
      const result = await writeIngestionEvent(admin, {
        ctx: CTX,
        topic: 'orders/create',
        deliveryId: 'wh-1',
        resourceKind: 'order',
        resourceExternalId: '123',
        status: 'done',
        triggeredAt: null,
      });
      expect(result).toEqual({ ok: false, error: 'permission denied' });
    });
  });

  describe('linkExternalRef — preuve #5 : collision sans écrasement', () => {
    it('même (store_connection, entity_type, external_id) déjà lié à une AUTRE entité → collision, jamais un écrasement', async () => {
      const admin = fakeAdmin({
        insertError: { code: '23505', message: 'dup' },
        selectResult: { data: { entity_id: 'existing-order-id' }, error: null },
      });
      const result = await linkExternalRef(admin, {
        ctx: CTX,
        entityType: 'order',
        externalId: 'ext-1',
        entityId: 'new-order-id',
      });
      expect(result).toEqual({ ok: false, error: 'collision' });
    });

    it('rejeu du même événement pour la MÊME entité → idempotent, pas une collision', async () => {
      const admin = fakeAdmin({
        insertError: { code: '23505', message: 'dup' },
        selectResult: { data: { entity_id: 'same-order-id' }, error: null },
      });
      const result = await linkExternalRef(admin, {
        ctx: CTX,
        entityType: 'order',
        externalId: 'ext-1',
        entityId: 'same-order-id',
      });
      expect(result).toEqual({ ok: true, alreadyLinked: true });
    });

    it('insertion propre (aucun conflit) → lié directement', async () => {
      const admin = fakeAdmin({ insertError: null });
      const result = await linkExternalRef(admin, {
        ctx: CTX,
        entityType: 'product',
        externalId: 'variant-1',
        entityId: 'product-row-1',
      });
      expect(result).toEqual({ ok: true, alreadyLinked: false });
    });
  });
});
