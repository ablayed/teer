import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const applicationOrigin = 'http://127.0.0.1:3010';
const require = createRequire(import.meta.url);
let phoneSequence = 0;

export async function startHttpHarness(databaseOrigin) {
  // Read only public action bindings; never emit or retain the manifest encryption key.
  const manifest = JSON.parse(
    fs.readFileSync('.next/server/server-reference-manifest.json', 'utf8'),
  ).node;
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    VERCEL_ENV: 'preview',
    NEXT_PUBLIC_SUPABASE_URL: databaseOrigin.href,
    GROQ_API_KEY: randomBytes(24).toString('hex'),
    SHOPIFY_API_KEY: 'synthetic-m1',
    SHOPIFY_API_SECRET: randomBytes(32).toString('hex'),
    RESEND_API_KEY: 'local-disabled',
    NEXT_TELEMETRY_DISABLED: '1',
    NODE_OPTIONS: `--require=${fileURLToPath(new URL('./s0-provider-preload.cjs', import.meta.url))}`,
  };
  for (const name of Object.keys(env))
    if (/^(UPSTASH_|SENTRY_|NEXT_PUBLIC_SENTRY_|POSTHOG_)/.test(name)) delete env[name];
  const server = spawn(
    process.execPath,
    [require.resolve('next/dist/bin/next'), 'start', '-p', '3010'],
    {
      env,
      stdio: 'ignore',
      windowsHide: true,
    },
  );
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      ready =
        (await fetch(`${applicationOrigin}/api/shopify/webhooks`, { method: 'POST', body: '{}' }))
          .status === 401;
    } catch {
      /* local server still starting */
    }
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ready) server.kill();
  assert.ok(ready, 'isolated next start must be ready');
  return { server, manifest };
}

function cookie(actor) {
  return [...actor.jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

export function registerHttpCases(ctx) {
  const { actors, tenants, admin, fixture, owned, allRoles, managers, results, idFor, httpState } =
    ctx;
  function record(id, actor, tenant, resource, operation, transport, expected, observed, status) {
    const passed = expected === observed;
    results.push({
      id,
      actor: actor.label,
      tenant: tenant.label,
      resource,
      operation,
      transport,
      expectedAllowed: expected,
      observedAllowed: observed,
      status,
      assessment:
        status >= 500
          ? 'NEEDS INVESTIGATION: fail-closed response'
          : passed
            ? 'EXPECTED BEHAVIOR OBSERVED'
            : 'MISMATCH',
      passed,
    });
    assert.equal(
      passed,
      true,
      `${id}: expectedAllowed=${expected}; observedAllowed=${observed}; status=${status}`,
    );
  }
  for (const actor of actors)
    for (const tenant of tenants) {
      for (const page of ['produits', 'finances'])
        test(`RSC/${page}/${actor.label}/${tenant.label}`, async () => {
          let response = await fetch(
            `${applicationOrigin}/s/${tenant.shopId}/${page}?tab=resultat`,
            { headers: { cookie: cookie(actor), RSC: '1' }, redirect: 'manual' },
          );
          if (response.status === 307) {
            const location = new URL(response.headers.get('location'), applicationOrigin);
            assert.equal(location.origin, applicationOrigin, 'RSC redirect must stay local');
            assert.ok(
              location.searchParams.has('_rsc'),
              `unexpected RSC redirect to ${location.pathname}`,
            );
            response = await fetch(location, {
              headers: { cookie: cookie(actor), RSC: '1' },
              redirect: 'manual',
            });
          }
          const body = await response.text();
          const expected =
            owned(actor, tenant) &&
            (page === 'produits' ? allRoles.includes(actor.role) : actor.role === 'owner');
          const marker = page === 'produits' ? tenant.ids.stock : tenant.ids.finances;
          const observed = body.includes(marker);
          if (actor.role === 'agent') {
            assert.ok(
              !body.includes('91739173') && !body.includes('92749274'),
              'agent RSC must exclude private unit costs',
            );
          }
          record(
            `RSC/${page}`,
            actor,
            tenant,
            page,
            'read',
            'RSC',
            expected,
            observed,
            response.status,
          );
        });
      if (actor.role === 'agent')
        test(`RLS/private-cost/${actor.label}/${tenant.label}`, async () => {
          const result = await actor.client
            .from('product')
            .select('unit_cost')
            .eq('id', tenant.ids.stock);
          const denied = result.error?.code === '42501';
          record(
            'RLS/private-cost',
            actor,
            tenant,
            'stock-cost',
            'read',
            'PostgREST',
            false,
            !denied,
            result.status,
          );
        });
      for (const method of ['GET', 'POST'])
        test(`HTTP/orders/${method}/${actor.label}/${tenant.label}`, async () => {
          const input = {
            dateFrom: new Date(Date.now() - 86400000).toISOString(),
            dateTo: new Date(Date.now() + 86400000).toISOString(),
            q: '',
            shopId: tenant.shopId,
            view: 'toutes',
          };
          const url = new URL('/api/orders/search', applicationOrigin);
          if (method === 'GET')
            for (const [name, value] of Object.entries(input)) url.searchParams.set(name, value);
          const response = await fetch(url, {
            method,
            headers: { cookie: cookie(actor), 'content-type': 'application/json' },
            ...(method === 'POST' ? { body: JSON.stringify(input) } : {}),
            signal: AbortSignal.timeout(15000),
          });
          const text = await response.text();
          const expected = owned(actor, tenant) && allRoles.includes(actor.role);
          const observed = response.status === 200 && text.includes(tenant.ids.orders);
          record(
            `HTTP/orders/${method}/${actor.label}/${tenant.label}`,
            actor,
            tenant,
            'orders',
            'list',
            'Route Handler',
            expected,
            observed,
            response.status,
          );
          if (actor.role === 'agent')
            assert.ok(
              !/"(?:unit_cost|unitCost|margin|cogs|grossMargin|purchase_price)"\s*:/.test(text),
              'agent response must omit sensitive financial fields',
            );
        });
      test(`HTTP/assistant/${actor.label}/${tenant.label}`, async () => {
        const response = await fetch(`${applicationOrigin}/api/assistant/chat`, {
          method: 'POST',
          headers: { cookie: cookie(actor), 'content-type': 'application/json' },
          body: JSON.stringify({
            conversationId: idFor('assistant', tenant, actor),
            messages: [
              { id: 'synthetic', role: 'user', parts: [{ type: 'text', text: 'Bonjour' }] },
            ],
          }),
          signal: AbortSignal.timeout(15000),
        });
        const text = await response.text();
        const expected = owned(actor, tenant) && allRoles.includes(actor.role);
        record(
          `HTTP/assistant/${actor.label}/${tenant.label}`,
          actor,
          tenant,
          'assistant',
          'generate',
          'Route Handler',
          expected,
          response.status === 200 && text.includes('LOCAL_STREAM_END_'),
          response.status,
        );
      });
      test(`HTTP/export-authorization/${actor.label}/${tenant.label}`, async () => {
        const response = await fetch(
          `${applicationOrigin}/api/shopify/dsar/${tenant.ids.exports}?shop_id=${tenant.shopId}`,
          { headers: { cookie: cookie(actor) }, signal: AbortSignal.timeout(15000) },
        );
        const body = await response.json();
        const expected = owned(actor, tenant) && managers.includes(actor.role);
        // The download token stays only in memory, never in reports or assertion output.
        record(
          `HTTP/export-authorization/${actor.label}/${tenant.label}`,
          actor,
          tenant,
          'exports',
          'authorize',
          'Route Handler',
          expected,
          response.status === 200 && typeof body.downloadToken === 'string',
          response.status,
        );
      });
      test(`HTTP/export-download/${actor.label}/${tenant.label}`, async () => {
        const expected = owned(actor, tenant) && managers.includes(actor.role);
        const issuer = expected
          ? actor
          : actors.find((a) => a.role === 'owner' && a.tenant === tenant.label);
        const authorization = await fixture(
          issuer.client.rpc('issue_shopify_dsar_download_authorization', {
            p_artifact_id: tenant.ids.exports,
            p_shop_id: tenant.shopId,
            p_tenant_id: tenant.id,
          }),
        );
        const response = await fetch(
          `${applicationOrigin}/api/shopify/dsar/${tenant.ids.exports}/download?shop_id=${tenant.shopId}`,
          {
            headers: {
              cookie: cookie(actor),
              'x-teer-dsar-download-token': authorization[0].download_token,
            },
            signal: AbortSignal.timeout(15000),
          },
        );
        const text = await response.text();
        record(
          `HTTP/export-download/${actor.label}/${tenant.label}`,
          actor,
          tenant,
          'exports',
          'download',
          'Route Handler',
          expected,
          response.status === 200 && text.includes('"synthetic":true'),
          response.status,
        );
      });
    }
  async function action(actor, tenant, name, args) {
    const found = Object.entries(httpState.manifest).find(
      ([, entry]) => entry.exportedName === name,
    );
    assert.ok(found, 'named action must exist in the actual build manifest');
    const [id, entry] = found;
    const worker = Object.keys(entry.workers).find(
      (path) => path.endsWith('/page') && !path.includes('['),
    );
    assert.ok(worker, 'action must have a concrete page worker');
    const route = worker
      .replace(/^app\//, '')
      .replace(/\/page$/, '')
      .split('/')
      .filter((part) => !part.startsWith('('))
      .join('/');
    const response = await fetch(`${applicationOrigin}/s/${tenant.shopId}/${route}`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        cookie: cookie(actor),
        origin: applicationOrigin,
        'next-action': id,
        'content-type': 'text/plain;charset=UTF-8',
        accept: 'text/x-component',
      },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(15000),
    });
    return { status: response.status, text: await response.text() };
  }
  const actionNames = [
    'getOrderById',
    'createManualOrderAction',
    'setOrderNoteAction',
    'listCustomersAction',
    'getCustomerAction',
    'updateDriverAction',
    'listTeamAction',
    'manualAdjustmentAction',
    'recordSettlementAction',
    'getFinanceReportAction',
    'createConversationAction',
    'listConversationsAction',
    'getConversationMessagesAction',
  ];
  for (const actor of actors)
    for (const tenant of tenants)
      for (const name of actionNames) {
        test(`Action/${name}/${actor.label}/${tenant.label}`, async () => {
          const marker = randomUUID();
          let args;
          let expected = owned(actor, tenant) && allRoles.includes(actor.role);
          let observed;
          if (
            [
              'updateDriverAction',
              'listTeamAction',
              'manualAdjustmentAction',
              'recordSettlementAction',
            ].includes(name)
          )
            expected = owned(actor, tenant) && managers.includes(actor.role);
          if (name === 'getFinanceReportAction')
            expected = owned(actor, tenant) && actor.role === 'owner';
          const countConversations = async () =>
            (
              await fixture(
                admin
                  .from('ia_conversation')
                  .select('id')
                  .eq('merchant_account_id', tenant.id)
                  .eq('user_id', actor.id ?? tenant.ownerId),
              )
            ).length;
          let beforeCount;
          let stockBefore;
          switch (name) {
            case 'getOrderById':
              args = [tenant.ids.orders];
              break;
            case 'createManualOrderAction':
              args = [
                {
                  customerName: marker,
                  phone: `+221770${String(++phoneSequence).padStart(6, '0')}`,
                  shopId: tenant.shopId,
                  lines: [{ productId: tenant.ids.stock, quantity: 1, unitPrice: 1000 }],
                },
              ];
              break;
            case 'setOrderNoteAction':
              args = [{ orderId: tenant.ids.orders, note: marker }];
              break;
            case 'listCustomersAction':
              args = [{ shopId: tenant.shopId }];
              break;
            case 'getCustomerAction':
              args = [{ shopId: tenant.shopId, customerId: tenant.ids.customers }];
              break;
            case 'updateDriverAction':
              args = [
                {
                  driverId: tenant.ids.drivers,
                  fullName: marker,
                  phone: 'synthetic-local',
                  isActive: true,
                },
              ];
              break;
            case 'listTeamAction':
              args = [{}];
              break;
            case 'manualAdjustmentAction':
              stockBefore = (
                await fixture(
                  admin
                    .from('product_stock')
                    .select('qty_on_hand')
                    .eq('product_id', tenant.ids.stock)
                    .single(),
                )
              ).qty_on_hand;
              args = [{ productId: tenant.ids.stock, qty: 1 }];
              break;
            case 'recordSettlementAction':
              args = [
                {
                  driverId: tenant.ids.drivers,
                  amountReceivedMinor: 0,
                  method: 'ESPECES',
                  clientRequestId: marker,
                  note: marker,
                },
              ];
              break;
            case 'getFinanceReportAction':
              args = [
                {
                  shopId: tenant.shopId,
                  from: new Date(Date.now() - 86400000).toISOString(),
                  to: new Date(Date.now() + 86400000).toISOString(),
                },
              ];
              break;
            case 'createConversationAction':
              beforeCount = await countConversations();
              args = [];
              break;
            case 'listConversationsAction':
              args = [];
              break;
            case 'getConversationMessagesAction':
              args = [{ conversationId: idFor('assistant', tenant, actor) }];
              break;
          }
          const response = await action(actor, tenant, name, args);
          switch (name) {
            case 'getOrderById':
              observed = response.text.includes(tenant.ids.orders);
              break;
            case 'createManualOrderAction': {
              const customers = await fixture(
                admin.from('customer').select('id').eq('full_name', marker),
              );
              observed = false;
              for (const customer of customers)
                if (
                  (await fixture(admin.from('orders').select('id').eq('customer_id', customer.id)))
                    .length
                )
                  observed = true;
              break;
            }
            case 'setOrderNoteAction':
              observed =
                (
                  await fixture(
                    admin.from('orders').select('note').eq('id', tenant.ids.orders).single(),
                  )
                ).note === marker;
              break;
            case 'listCustomersAction':
            case 'getCustomerAction':
              observed = response.text.includes(tenant.ids.customers);
              break;
            case 'updateDriverAction':
              observed =
                (
                  await fixture(
                    admin.from('driver').select('full_name').eq('id', tenant.ids.drivers).single(),
                  )
                ).full_name === marker;
              break;
            case 'listTeamAction':
              observed = response.text.includes(tenant.ids.drivers);
              break;
            case 'manualAdjustmentAction':
              observed =
                (
                  await fixture(
                    admin
                      .from('product_stock')
                      .select('qty_on_hand')
                      .eq('product_id', tenant.ids.stock)
                      .single(),
                  )
                ).qty_on_hand ===
                stockBefore + 1;
              break;
            case 'recordSettlementAction':
              observed =
                (
                  await fixture(
                    admin.from('cash_settlement').select('id').eq('client_request_id', marker),
                  )
                ).length > 0;
              break;
            case 'getFinanceReportAction': {
              const expenses = await fixture(
                admin.from('expense').select('amount_minor').eq('merchant_account_id', tenant.id),
              );
              const total = expenses.reduce((sum, row) => sum + Number(row.amount_minor), 0);
              observed = new RegExp(`(?:[:,\\[])\\s*${total}\\s*(?:[,}\\]])`).test(response.text);
              break;
            }
            case 'createConversationAction':
              observed = (await countConversations()) > beforeCount;
              break;
            case 'listConversationsAction':
              observed = response.text.includes(idFor('assistant', tenant, actor));
              break;
            case 'getConversationMessagesAction':
              observed = response.text.includes(
                actor.messages?.[tenant.label] ??
                  actors.find((a) => a.role === 'owner' && a.tenant === tenant.label).messages[
                    tenant.label
                  ],
              );
              break;
          }
          record(
            `Action/${name}/${actor.label}/${tenant.label}`,
            actor,
            tenant,
            name,
            'action',
            'Server Action HTTP',
            expected,
            observed,
            response.status,
          );
        });
      }
}
