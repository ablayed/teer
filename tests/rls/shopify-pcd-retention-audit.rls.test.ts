import { randomUUID } from 'node:crypto';
import { type TestPostgresClient, createTestPostgresClient } from '@/tests/helpers/postgres-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const dbUrl =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
const RUN_AT = '2026-11-02T12:00:00.000Z';
let pg: TestPostgresClient;

beforeAll(async () => {
  pg = createTestPostgresClient(dbUrl);
  await pg.connect();
});

afterAll(async () => {
  await pg?.end();
});

async function withExpiredCustomerIdentity(
  run: (fixture: {
    merchantAccountId: string;
    shopId: string;
    customerIds: string[];
  }) => Promise<void>,
) {
  await pg.query('begin');
  try {
    const suffix = randomUUID();
    const userId = randomUUID();
    const { rows: userRows } = await pg.query<{ id: string }>(
      `insert into auth.users (
         id, aud, role, email, encrypted_password, email_confirmed_at,
         raw_app_meta_data, raw_user_meta_data, created_at, updated_at
       ) values ($1, 'authenticated', 'authenticated', $2, '', now(), '{}', '{}', now(), now())
       returning id`,
      [userId, `retention-${suffix}@example.test`],
    );
    expect(userRows).toHaveLength(1);

    const { rows: accountRows } = await pg.query<{ id: string }>(
      `insert into public.merchant_account (name, owner_user_id)
       values ($1, $2) returning id`,
      [`Retention test ${suffix}`, userId],
    );
    const merchantAccountId = accountRows[0]?.id;
    if (!merchantAccountId) throw new Error('Compte test absent');

    const { rows: shopRows } = await pg.query<{ id: string }>(
      `insert into public.shop (merchant_account_id, shop_domain, scopes)
       values ($1, $2, 'read_customers,read_orders,read_products') returning id`,
      [merchantAccountId, `retention-${suffix}.myshopify.com`],
    );
    const shopId = shopRows[0]?.id;
    if (!shopId) throw new Error('Boutique test absente');

    const customerIds: string[] = [];
    for (const index of [1, 2]) {
      const marker = `${suffix}-${index}`;
      const { rows: customerRows } = await pg.query<{ id: string }>(
        `insert into public.customer (
           merchant_account_id, shop_id, shopify_customer_id, full_name, phone,
           address, shipping_address, shopify_last_activity_at
         ) values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8) returning id`,
        [
          merchantAccountId,
          shopId,
          `retention-external-${marker}`,
          `Retention PII ${marker}`,
          `+1555${marker.replaceAll('-', '').slice(0, 7)}`,
          JSON.stringify({ address1: `Address PII ${marker}` }),
          JSON.stringify({ address1: `Shipping PII ${marker}` }),
          '2025-10-01T00:00:00.000Z',
        ],
      );
      const customerId = customerRows[0]?.id;
      if (!customerId) throw new Error('Client test absent');
      customerIds.push(customerId);

      await pg.query(
        `insert into public.orders (
           merchant_account_id, shop_id, customer_id, shopify_order_id, order_number,
           total_amount, order_state, delivery_state, cash_state, shipping_address, note
         ) values ($1, $2, $3, $4, $5, 1000, 'completed', 'delivered', 'not_due', $6::jsonb, $7)`,
        [
          merchantAccountId,
          shopId,
          customerId,
          `retention-order-${marker}`,
          `#RETENTION-${marker}`,
          JSON.stringify({ address1: `Order address PII ${marker}` }),
          `Order note PII ${marker}`,
        ],
      );
    }

    await run({ merchantAccountId, shopId, customerIds });
  } finally {
    await pg.query('rollback');
  }
}

describe('audit de la purge des identités Shopify', () => {
  it('la prévisualisation reste sans écriture et la purge écrit une ligne sans donnée client', async () => {
    await withExpiredCustomerIdentity(async ({ merchantAccountId, shopId, customerIds }) => {
      const beforeRuns = await pg.query<{ count: string }>(
        'select count(*)::text as count from public.shopify_pcd_purge_run',
      );
      const beforeAudits = await pg.query<{ count: string }>(
        `select count(*)::text as count from public.audit_log
          where merchant_account_id = $1 and action = 'retention.customer_identity_purged'`,
        [merchantAccountId],
      );

      await pg.query('set local role service_role');
      await pg.query("select set_config('request.jwt.claim.role', 'service_role', true)");

      const preview = await pg.query<{ target_id: string }>(
        `select target_id
           from public.shopify_pcd_retention_candidates($1::timestamptz)
          where category = 'expired_customer_identity' and target_id = any($2::uuid[])`,
        [RUN_AT, customerIds],
      );
      expect(preview.rows.map((row) => row.target_id).sort()).toEqual([...customerIds].sort());

      const afterPreviewRuns = await pg.query<{ count: string }>(
        'select count(*)::text as count from public.shopify_pcd_purge_run',
      );
      const afterPreviewAudits = await pg.query<{ count: string }>(
        `select count(*)::text as count from public.audit_log
          where merchant_account_id = $1 and action = 'retention.customer_identity_purged'`,
        [merchantAccountId],
      );
      const beforePurgeCustomer = await pg.query<{ full_name: string | null }>(
        'select full_name from public.customer where id = any($1::uuid[])',
        [customerIds],
      );
      expect(afterPreviewRuns.rows[0]?.count).toBe(beforeRuns.rows[0]?.count);
      expect(afterPreviewAudits.rows[0]?.count).toBe(beforeAudits.rows[0]?.count);
      expect(beforePurgeCustomer.rows).toHaveLength(2);
      expect(
        beforePurgeCustomer.rows.every((row) => row.full_name?.includes('Retention PII')),
      ).toBe(true);

      const purge = await pg.query<{
        summary: { customer_identity_count: number; error_count: number };
      }>('select public.execute_shopify_pcd_retention(100, $1::timestamptz) as summary', [RUN_AT]);
      expect(purge.rows[0]?.summary).toMatchObject({ customer_identity_count: 2, error_count: 0 });

      const audits = await pg.query<{
        actor_user_id: string | null;
        action: string;
        payload: unknown;
        resource_id: string | null;
        resource_type: string | null;
      }>(
        `select actor_user_id, action, resource_type, resource_id, payload
           from public.audit_log
          where merchant_account_id = $1
            and action = 'retention.customer_identity_purged'
            and resource_id = $2`,
        [merchantAccountId, shopId],
      );
      expect(audits.rows).toHaveLength(customerIds.length);
      for (const audit of audits.rows) {
        expect(audit).toMatchObject({
          actor_user_id: null,
          action: 'retention.customer_identity_purged',
          resource_type: 'shop',
          resource_id: shopId,
          payload: { status: 'done', counts: { customer_identity_count: 1 } },
        });

        const serializedAudit = JSON.stringify(audit);
        for (const forbiddenValue of [
          'Retention PII',
          '+1555',
          'Address PII',
          'Shipping PII',
          'Order address PII',
          'Order note PII',
          'retention-external-',
        ]) {
          expect(serializedAudit).not.toContain(forbiddenValue);
        }
      }

      const privileges = await pg.query<{
        anon_exec: boolean;
        authenticated_exec: boolean;
        service_role_exec: boolean;
      }>(`
        select has_function_privilege('anon', 'public.execute_shopify_pcd_retention(integer,timestamptz)', 'EXECUTE') as anon_exec,
               has_function_privilege('authenticated', 'public.execute_shopify_pcd_retention(integer,timestamptz)', 'EXECUTE') as authenticated_exec,
               has_function_privilege('service_role', 'public.execute_shopify_pcd_retention(integer,timestamptz)', 'EXECUTE') as service_role_exec
      `);
      expect(privileges.rows[0]).toEqual({
        anon_exec: false,
        authenticated_exec: false,
        service_role_exec: true,
      });
    });
  });
});
