import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Database } from '@/lib/supabase/database.types';
import { type SupabaseClient, createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ client: null as unknown as SupabaseClient<Database> }));
// The session client is real; getUser and membership/role checks are not mocked.
vi.mock('@/lib/supabase/server', () => ({ createSupabaseServerClient: async () => state.client }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  addBreadcrumb: vi.fn(),
}));
import { createExpenseAction, updateExpenseAction } from '@/lib/actions/expenses';
import { getFinanceReportAction } from '@/lib/actions/profit';

const origin = process.env.SUPABASE_URL ?? '';
assert.equal(new URL(origin).origin, 'http://127.0.0.1:54321');
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient<Database>(origin, process.env.SUPABASE_SERVICE_ROLE_KEY ?? '', options);
const actors: {
  userId: string;
  tenantId: string;
  categoryId: string;
  client: SupabaseClient<Database>;
}[] = [];
const privateLabel = `SYNTHETIC_PRIVATE_CATEGORY_${randomUUID()}`;
const originalFetch = globalThis.fetch;

beforeAll(async () => {
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.origin, 'http://127.0.0.1:54321', 'proof forbids every remote request');
    return originalFetch(input, init);
  };
  for (let i = 0; i < 2; i++) {
    const email = `expense-proof-${randomUUID()}@example.test`;
    const password = randomBytes(32).toString('hex');
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    assert.ok(!created.error && created.data.user, 'synthetic Auth user must be created');
    const userId = created.data.user.id;
    const member = await admin
      .from('merchant_member')
      .select('merchant_account_id')
      .eq('user_id', userId)
      .single();
    assert.ok(!member.error && member.data, 'synthetic owner membership must exist');
    const client = createClient<Database>(origin, process.env.SUPABASE_ANON_KEY ?? '', options);
    assert.ok(
      !(await client.auth.signInWithPassword({ email, password })).error,
      'local session must authenticate',
    );
    const category = await client
      .from('expense_category')
      .insert({
        merchant_account_id: member.data.merchant_account_id,
        code: `PROOF_${i}`,
        label_fr: i === 1 ? privateLabel : 'Synthetic own category',
        is_system: false,
      })
      .select('id')
      .single();
    assert.ok(!category.error && category.data, 'owner must create its own category');
    actors.push({
      userId,
      tenantId: member.data.merchant_account_id,
      categoryId: category.data.id,
      client,
    });
  }
  state.client = actors[0].client;
});
afterAll(async () => {
  // Remove referencing rows before foreign categories; preserve no synthetic cross-tenant link.
  for (const actor of actors)
    await admin.from('expense').delete().eq('merchant_account_id', actor.tenantId);
  for (const actor of actors) {
    await admin.from('merchant_account').delete().eq('id', actor.tenantId);
    await admin.auth.admin.deleteUser(actor.userId);
  }
  globalThis.fetch = originalFetch;
});
const payload = (categoryId: string) => ({
  categoryId,
  amountMinor: 100,
  spentAt: new Date().toISOString().slice(0, 10),
});

it('positive: owner A creates an expense under category A', async () => {
  const result = await createExpenseAction(payload(actors[0].categoryId));
  expect(result?.data?.ok).toBe(true);
});

it('positive: own expense remains editable and visible in the financial report', async () => {
  const created = await createExpenseAction(payload(actors[0].categoryId));
  assert.ok(created?.data?.ok, 'own category must remain writable');
  const updated = await updateExpenseAction({
    ...payload(actors[0].categoryId),
    id: created.data.id,
    amountMinor: 200,
  });
  expect(updated?.data?.ok).toBe(true);
  const report = await getFinanceReportAction({
    from: new Date(Date.now() - 86400000).toISOString(),
    to: new Date(Date.now() + 86400000).toISOString(),
  });
  expect(report?.data?.ok).toBe(true);
  expect(JSON.stringify(report)).toContain('Synthetic own category');
});

it('positive: own JWT retains expense create, edit and delete with an own category', async () => {
  const actor = actors[0];
  const created = await actor.client
    .from('expense')
    .insert({
      merchant_account_id: actor.tenantId,
      category_id: actor.categoryId,
      amount_minor: 201,
      spent_at: new Date().toISOString().slice(0, 10),
      created_by: actor.userId,
    })
    .select('id')
    .single();
  assert.ok(!created.error && created.data, 'own JWT expense insert must succeed');
  const id = created.data.id;
  const changed = await actor.client
    .from('expense')
    .update({ amount_minor: 202 })
    .eq('id', id)
    .select('amount_minor')
    .single();
  expect(changed.error).toBeNull();
  expect(changed.data?.amount_minor).toBe(202);
  const deleted = await actor.client.from('expense').delete().eq('id', id).select('id');
  expect(deleted.error).toBeNull();
  expect(deleted.data?.length).toBe(1);
});

it('positive: deleting an own used category remains restricted and preserves its expense', async () => {
  const created = await createExpenseAction(payload(actors[0].categoryId));
  assert.ok(created?.data?.ok, 'own expense fixture must succeed');
  const deletion = await actors[0].client
    .from('expense_category')
    .delete()
    .eq('id', actors[0].categoryId);
  expect(deletion.error?.code).toBe('23503');
  const remaining = await admin.from('expense').select('id').eq('id', created.data.id).single();
  expect(remaining.error).toBeNull();
  expect(remaining.data?.id).toBe(created.data.id);
});

it('database: a category tenant cannot change while its own expense references it', async () => {
  const changed = await admin
    .from('expense_category')
    .update({ merchant_account_id: actors[1].tenantId })
    .eq('id', actors[0].categoryId);
  expect(changed.error?.code).toBe('23503');
});

it('SEC-A-002: owner A must not reference or read private expense category B through finance', async () => {
  const hidden = await actors[0].client
    .from('expense_category')
    .select('id')
    .eq('id', actors[1].categoryId);
  expect(hidden.error).toBeNull();
  expect(hidden.data).toHaveLength(0);
  const result = await createExpenseAction(payload(actors[1].categoryId));
  const relation = await admin
    .from('expense')
    .select('id', { count: 'exact' })
    .eq('merchant_account_id', actors[0].tenantId)
    .eq('category_id', actors[1].categoryId);
  assert.ok(!relation.error, 'post-state observation must succeed');
  const report = await getFinanceReportAction({
    from: new Date(Date.now() - 86400000).toISOString(),
    to: new Date(Date.now() + 86400000).toISOString(),
  });
  const foreignLabelPresent = JSON.stringify(report).includes(privateLabel);
  // Only booleans, no credentials, UUIDs or category contents in evidence output.
  console.info(
    JSON.stringify({
      actionAccepted: result?.data?.ok === true,
      crossTenantReference: relation.count === 1,
      foreignLabelPresent,
    }),
  );
  expect({
    accepted: result?.data?.ok === true,
    foreignReference: relation.count === 1,
    foreignLabelPresent,
  }).toEqual({ accepted: false, foreignReference: false, foreignLabelPresent: false });
});

it('SEC-A-002: owner A must not attach category B through direct PostgREST', async () => {
  const result = await actors[0].client
    .from('expense')
    .insert({
      merchant_account_id: actors[0].tenantId,
      category_id: actors[1].categoryId,
      amount_minor: 101,
      spent_at: new Date().toISOString().slice(0, 10),
      created_by: actors[0].userId,
    })
    .select('id');
  expect({ accepted: !result.error && result.data?.length === 1 }).toEqual({ accepted: false });
});

it('SEC-A-002: updating an own expense must not attach category B', async () => {
  const created = await createExpenseAction(payload(actors[0].categoryId));
  assert.ok(created?.data?.ok, 'legitimate expense fixture must succeed');
  const result = await updateExpenseAction({
    ...payload(actors[1].categoryId),
    id: created.data.id,
  });
  const observed = await admin
    .from('expense')
    .select('category_id')
    .eq('id', created.data.id)
    .single();
  assert.ok(!observed.error && observed.data, 'post-state observation must succeed');
  expect({
    accepted: result?.data?.ok === true,
    foreignReference: observed.data.category_id === actors[1].categoryId,
  }).toEqual({ accepted: false, foreignReference: false });
});

it('SEC-A-002 positive: owner B must retain ability to delete its unused private category', async () => {
  const result = await actors[1].client
    .from('expense_category')
    .delete()
    .eq('id', actors[1].categoryId)
    .select('id');
  expect({ errorCode: result.error?.code ?? null, deleted: result.data?.length === 1 }).toEqual({
    errorCode: null,
    deleted: true,
  });
});
