import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { after, before, test } from 'node:test';
import { createServerClient } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { registerHttpCases, startHttpHarness } from './m1-http-cases.mjs';

// Standalone local integration matrix; no production configuration or .env loading.
const origin = new URL(process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321');
assert.equal(origin.hostname, '127.0.0.1');
assert.equal(origin.port, '54321');
const authOptions = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(origin.href, process.env.SUPABASE_SERVICE_ROLE_KEY, authOptions);
const makeClient = (actor) => {
  actor.jar = new Map();
  return createServerClient(origin.href, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false },
    cookies: {
      getAll: () => [...actor.jar].map(([name, value]) => ({ name, value })),
      setAll: (values) => {
        for (const { name, value } of values) actor.jar.set(name, value);
      },
    },
  });
};
const httpState = {};
const actors = [
  ...['A', 'B'].flatMap((tenant) =>
    ['owner', 'manager', 'agent', 'driver'].map((role) => ({
      label: `${role}-${tenant}`,
      role,
      tenant,
      active: role !== 'driver',
    })),
  ),
  { label: 'revoked-A', role: 'agent', tenant: 'A', active: false },
  { label: 'anonymous', role: 'anonymous', tenant: null, active: false },
];
const tenants = [{ label: 'A' }, { label: 'B' }];
const results = [];
const allRoles = ['owner', 'manager', 'agent'];
const managers = ['owner', 'manager'];
const resourceNames = [
  'orders',
  'customers',
  'drivers',
  'cash',
  'finances',
  'stock',
  'exports',
  'assistant',
];
const operations = ['read', 'list', 'create', 'modify'];

async function fixture(query) {
  const result = await query;
  assert.ok(!result.error, 'synthetic fixture operation must succeed');
  return result.data;
}
async function insert(table, body) {
  return fixture(admin.from(table).insert(body).select('id').single());
}
function owned(actor, tenant) {
  return actor.active && actor.tenant === tenant.label;
}
function rolesFor(resource, operation) {
  if (resource === 'exports') return [];
  if (resource === 'finances') return ['owner'];
  if (resource === 'cash') return operation === 'modify' ? [] : managers;
  if ((resource === 'drivers' || resource === 'stock') && ['create', 'modify'].includes(operation))
    return managers;
  return allRoles;
}
function tableFor(resource) {
  return {
    orders: 'orders',
    customers: 'customer',
    drivers: 'driver',
    cash: 'cash_settlement',
    finances: 'expense',
    stock: 'product_stock',
    exports: 'shopify_dsar_artifact',
    assistant: 'ia_conversation',
  }[resource];
}
function idFor(resource, tenant, actor) {
  if (resource === 'assistant') return actor.conversations?.[tenant.label] ?? tenant.ids.assistant;
  return tenant.ids[resource];
}
function keyFor(resource) {
  return resource === 'stock' ? 'product_id' : 'id';
}

before(async () => {
  for (const actor of actors) {
    actor.client = makeClient(actor);
    if (actor.role === 'anonymous') continue;
    const email = `m1-${randomUUID()}@example.test`;
    const password = randomBytes(32).toString('hex');
    const created = await fixture(
      admin.auth.admin.createUser({ email, password, email_confirm: true }),
    );
    actor.id = created.user.id;
    const member = await fixture(
      admin.from('merchant_member').select('merchant_account_id').eq('user_id', actor.id).single(),
    );
    const account = member.merchant_account_id;
    if (actor.role === 'owner') {
      const tenant = tenants.find((t) => t.label === actor.tenant);
      tenant.id = account;
      tenant.ownerId = actor.id;
      const shop = await fixture(
        admin
          .from('shop')
          .select('id,shop_domain')
          .eq('merchant_account_id', account)
          .eq('is_default', true)
          .single(),
      );
      tenant.shopId = shop.id;
      tenant.domain = shop.shop_domain;
    } else {
      await fixture(admin.from('merchant_account').delete().eq('id', account));
    }
    assert.ok(
      !(await actor.client.auth.signInWithPassword({ email, password })).error,
      'local sign-in must succeed',
    );
  }
  for (const actor of actors.filter((a) => a.id && a.role !== 'owner')) {
    const tenant = tenants.find((t) => t.label === actor.tenant);
    if (actor.role !== 'driver') {
      await fixture(
        admin
          .from('merchant_member')
          .insert({ user_id: actor.id, merchant_account_id: tenant.id, role: actor.role }),
      );
      const membership = await fixture(
        admin
          .from('shop_member')
          .select('id')
          .eq('shop_id', tenant.shopId)
          .eq('user_id', actor.id)
          .maybeSingle(),
      );
      if (!membership)
        await fixture(
          admin.from('shop_member').insert({
            shop_id: tenant.shopId,
            merchant_account_id: tenant.id,
            user_id: actor.id,
            role: actor.role,
          }),
        );
    }
  }
  for (const tenant of tenants) {
    await fixture(
      admin
        .from('merchant_account')
        .update({ onboarded_at: new Date().toISOString() })
        .eq('id', tenant.id),
    );
    tenant.ids = {};
    const driverActor = actors.find((a) => a.role === 'driver' && a.tenant === tenant.label);
    tenant.ids.drivers = (
      await insert('driver', {
        merchant_account_id: tenant.id,
        full_name: 'Synthetic driver',
        phone: 'synthetic-local',
        user_id: driverActor.id,
      })
    ).id;
    await fixture(
      admin.from('driver_shop').insert({
        driver_id: tenant.ids.drivers,
        shop_id: tenant.shopId,
        merchant_account_id: tenant.id,
      }),
    );
    tenant.ids.customers = (
      await insert('customer', {
        merchant_account_id: tenant.id,
        shop_id: tenant.shopId,
        full_name: 'Synthetic customer',
      })
    ).id;
    tenant.ids.orders = (
      await insert('orders', {
        merchant_account_id: tenant.id,
        shop_id: tenant.shopId,
        customer_id: tenant.ids.customers,
        total_amount: 1000,
        order_state: 'open',
        call_state: 'to_call',
        delivery_state: 'unassigned',
        cash_state: 'not_due',
      })
    ).id;
    tenant.ids.stock = (
      await insert('product', {
        merchant_account_id: tenant.id,
        shop_id: tenant.shopId,
        title: 'Synthetic product',
        unit_cost: tenant.label === 'A' ? 91739173 : 92749274,
      })
    ).id;
    await fixture(
      admin.from('product_stock').upsert(
        {
          product_id: tenant.ids.stock,
          merchant_account_id: tenant.id,
          shop_id: tenant.shopId,
          qty_on_hand: 10,
          qty_reserved: 0,
        },
        { onConflict: 'product_id' },
      ),
    );
    tenant.categoryId = (
      await insert('expense_category', {
        merchant_account_id: tenant.id,
        code: 'M1_SYNTHETIC',
        label_fr: 'Synthetic category',
        is_system: false,
      })
    ).id;
    tenant.ids.finances = (
      await insert('expense', {
        merchant_account_id: tenant.id,
        category_id: tenant.categoryId,
        amount_minor: tenant.label === 'A' ? 1739 : 2783,
        created_by: tenant.ownerId,
        spent_at: new Date().toISOString(),
      })
    ).id;
    tenant.ids.cash = (
      await insert('cash_settlement', {
        merchant_account_id: tenant.id,
        driver_id: tenant.ids.drivers,
        amount_received_minor: 0,
        method: 'ESPECES',
        created_by: tenant.ownerId,
        client_request_id: randomUUID(),
      })
    ).id;
    tenant.eventId = (
      await insert('webhook_event', {
        merchant_account_id: tenant.id,
        shop_id: tenant.shopId,
        shop_domain: tenant.domain,
        shopify_webhook_id: randomUUID(),
        topic: 'customers/data_request',
        status: 'done',
        processed: true,
        payload: { synthetic: true },
      })
    ).id;
    tenant.storagePath = `${tenant.id}/${tenant.eventId}.json`;
    tenant.ids.exports = (
      await insert('shopify_dsar_artifact', {
        merchant_account_id: tenant.id,
        shop_id: tenant.shopId,
        webhook_event_id: tenant.eventId,
        storage_path: tenant.storagePath,
        storage_bucket: 'shopify-dsar',
        status: 'ready',
        byte_size: 18,
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        completed_at: new Date().toISOString(),
      })
    ).id;
    await fixture(
      admin.storage
        .from('shopify-dsar')
        .upload(tenant.storagePath, Buffer.from('{"synthetic":true}'), {
          contentType: 'application/json',
          upsert: true,
        }),
    );
    for (const actor of actors.filter((a) => a.id)) {
      actor.conversations ??= {};
      actor.messages ??= {};
      actor.conversations[tenant.label] = (
        await insert('ia_conversation', {
          merchant_account_id: tenant.id,
          user_id: actor.id,
          title: 'Synthetic conversation',
        })
      ).id;
      actor.messages[tenant.label] = (
        await insert('ia_message', {
          merchant_account_id: tenant.id,
          conversation_id: actor.conversations[tenant.label],
          role: 'user',
          content: 'Synthetic message',
        })
      ).id;
    }
    tenant.ids.assistant = actors.find(
      (a) => a.role === 'owner' && a.tenant === tenant.label,
    ).conversations[tenant.label];
  }
  const revoked = actors.find((a) => a.label === 'revoked-A');
  // Exercise the real authenticated layout, including legitimate consent/onboarding guards.
  const documents = await fixture(
    admin
      .from('legal_documents')
      .select('type,version,content_hash')
      .eq('is_current', true)
      .in('type', ['cgu', 'privacy', 'mentions', 'dpa']),
  );
  assert.ok(documents.length > 0, 'current legal documents must be seeded');
  for (const actor of actors.filter((a) => a.id)) {
    await fixture(
      admin.from('user_consents').insert(
        documents.map((document) => ({
          user_id: actor.id,
          document_type: document.type,
          document_version: document.version,
          content_hash: document.content_hash,
          method: 'signup_checkbox',
        })),
      ),
    );
  }
  await fixture(admin.from('shop_member').delete().eq('user_id', revoked.id));
  await fixture(admin.from('merchant_member').delete().eq('user_id', revoked.id));
  assert.ok(
    (await revoked.client.auth.getUser()).data.user,
    'revoked actor still has a valid Auth session',
  );
  Object.assign(httpState, await startHttpHarness(origin));
});

async function execute(actor, tenant, resource, operation, marker) {
  const table = tableFor(resource);
  const id = idFor(resource, tenant, actor);
  const key = keyFor(resource);
  const client = actor.client;
  if (operation === 'read' || operation === 'list') {
    let query = client.from(table).select(key).eq('merchant_account_id', tenant.id);
    if (operation === 'read') query = query.eq(key, id);
    return { result: await query, observed: 'rows' };
  }
  if (resource === 'stock') {
    const result = await client.rpc('post_stock_movement', {
      p_merchant_account_id: tenant.id,
      p_product_id: tenant.ids.stock,
      p_movement_type: 'manual_adjustment',
      p_qty: 1,
      p_idempotency_key: marker,
      p_created_by: actor.id ?? tenant.ownerId,
      p_expected_shop_id: tenant.shopId,
      p_reason: 'Synthetic matrix adjustment',
    });
    const rows = await fixture(
      admin.from('stock_movement').select('id').eq('idempotency_key', marker),
    );
    return { result, observed: rows.length > 0 };
  }
  if (resource === 'orders' && operation === 'modify') {
    const result = await client.rpc('set_order_note', { p_order_id: id, p_note: marker });
    const row = await fixture(admin.from('orders').select('note').eq('id', id).single());
    return { result, observed: row.note === marker };
  }
  if (resource === 'cash' && operation === 'create') {
    const result = await client.rpc('record_cash_settlement', {
      p_merchant: tenant.id,
      p_driver: tenant.ids.drivers,
      p_amount_received_minor: 0,
      p_method: 'ESPECES',
      p_note: marker,
      p_client_request_id: marker,
    });
    const rows = await fixture(
      admin.from('cash_settlement').select('id').eq('client_request_id', marker),
    );
    return { result, observed: rows.length > 0 };
  }
  if (operation === 'modify') {
    const field = {
      customers: 'full_name',
      drivers: 'full_name',
      cash: 'note',
      finances: 'note',
      exports: 'storage_path',
      assistant: 'title',
    }[resource];
    const result = await client
      .from(table)
      .update({ [field]: marker })
      .eq(key, id)
      .select(key);
    const row = await fixture(admin.from(table).select(field).eq(key, id).single());
    return { result, observed: row[field] === marker };
  }
  const common = { id: marker, merchant_account_id: tenant.id };
  const bodies = {
    orders: {
      ...common,
      shop_id: tenant.shopId,
      customer_id: tenant.ids.customers,
      total_amount: 1000,
      order_state: 'open',
      call_state: 'to_call',
      delivery_state: 'unassigned',
      cash_state: 'not_due',
    },
    customers: { ...common, shop_id: tenant.shopId, full_name: 'Synthetic customer' },
    drivers: { ...common, full_name: 'Synthetic driver', phone: 'synthetic-local' },
    finances: {
      ...common,
      category_id: tenant.categoryId,
      amount_minor: 100,
      created_by: actor.id ?? tenant.ownerId,
      spent_at: new Date().toISOString(),
    },
    exports: {
      ...common,
      shop_id: tenant.shopId,
      webhook_event_id: tenant.eventId,
      storage_path: marker,
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    },
    assistant: { ...common, user_id: actor.id ?? tenant.ownerId, title: 'Synthetic conversation' },
  };
  const result = await client.from(table).insert(bodies[resource]).select(key);
  const rows = await fixture(admin.from(table).select(key).eq(key, marker));
  return { result, observed: rows.length > 0 };
}

for (const actor of actors)
  for (const tenant of tenants)
    for (const resource of resourceNames)
      for (const operation of operations) {
        const id = `${actor.label}/${tenant.label}/${resource}/${operation}`;
        test(id, async () => {
          const expected =
            owned(actor, tenant) && rolesFor(resource, operation).includes(actor.role);
          const { result, observed } = await execute(
            actor,
            tenant,
            resource,
            operation,
            randomUUID(),
          );
          const allowed =
            observed === 'rows'
              ? !result.error && Array.isArray(result.data) && result.data.length > 0
              : observed;
          const errorCode = result.error?.code ?? null;
          const denial =
            !result.error ||
            errorCode === '42501' ||
            /^PGRST30[123]$/.test(errorCode ?? '') ||
            /forbidden|unauthenticated|unauthorized|not.authorized|not.member|not.found|permission|access.denied|tenant|shop/i.test(
              result.error.message ?? '',
            );
          const passed = allowed === expected && (expected ? !result.error : denial);
          results.push({
            id,
            actor: actor.label,
            tenant: tenant.label,
            resource,
            operation,
            transport:
              (resource === 'stock' && ['create', 'modify'].includes(operation)) ||
              (resource === 'cash' && operation === 'create') ||
              (resource === 'orders' && operation === 'modify')
                ? 'RPC'
                : 'PostgREST-RLS',
            expectedAllowed: expected,
            observedAllowed: allowed,
            errorCode,
            passed,
          });
          assert.equal(
            passed,
            true,
            `authorization mismatch; expectedAllowed=${expected}; observedAllowed=${allowed}; code=${errorCode}`,
          );
        });
      }

registerHttpCases({
  actors,
  tenants,
  admin,
  fixture,
  owned,
  allRoles,
  managers,
  results,
  idFor,
  httpState,
});

after(async () => {
  httpState.server?.kill();
  const output = process.env.M1_RESULTS_PATH;
  if (output)
    fs.writeFileSync(
      output,
      `${JSON.stringify(
        {
          applicableIdentified: 1046,
          executed: results.length,
          passed: results.filter((r) => r.passed).length,
          cases: results,
          limits:
            'Identified scope: 640 RLS/RPC cases,100 Route Handler cases,260 Server Action HTTP cases,40 RSC cases,6 private-cost column checks (including revoked agent). Other action variants and direct AI-tool execution are outside this percentage. No driver TeamRole exists; linked Auth users are tested without merchant membership. Twenty negative HTTP cases return 503 and require investigation, not a VERIFIED SECURE classification.',
        },
        null,
        2,
      )}\n`,
    );
  for (const tenant of tenants) {
    if (tenant.storagePath) await admin.storage.from('shopify-dsar').remove([tenant.storagePath]);
    if (tenant.eventId)
      await admin.from('shopify_dsar_artifact').delete().eq('webhook_event_id', tenant.eventId);
    if (tenant.eventId) await admin.from('webhook_event').delete().eq('id', tenant.eventId);
  }
  for (const actor of actors.filter((a) => a.role === 'owner'))
    if (actor.id) await admin.auth.admin.deleteUser(actor.id);
  for (const actor of actors.filter((a) => a.role !== 'owner'))
    if (actor.id) await admin.auth.admin.deleteUser(actor.id);
});
