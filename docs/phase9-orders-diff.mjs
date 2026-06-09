import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';

const password = 'mot-de-passe-phase9-orders';
const views = [
  'toutes',
  'a-appeler',
  'tentee-a-rappeler',
  'confirmee',
  'a-livrer-aujourdhui',
  'cash-a-remettre',
  'annulees',
  'retours',
];

function parseSupabaseStatusEnv() {
  const output =
    process.platform === 'win32'
      ? execFileSync('cmd.exe', ['/d', '/s', '/c', 'pnpm exec supabase status -o env'], {
          cwd: process.cwd(),
          encoding: 'utf8',
        })
      : execFileSync('pnpm', ['exec', 'supabase', 'status', '-o', 'env'], {
          cwd: process.cwd(),
          encoding: 'utf8',
        });
  const env = {};

  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)="?(.*?)"?$/);
    if (!match) {
      continue;
    }

    env[match[1]] = match[2];
  }

  return env;
}

function psql(sql) {
  const output = execFileSync(
    process.platform === 'win32' ? 'cmd.exe' : 'docker',
    process.platform === 'win32'
      ? [
          '/d',
          '/s',
          '/c',
          'docker exec -i supabase_db_teer-dev psql -U postgres -d postgres -t -A -q',
        ]
      : [
          'exec',
          '-i',
          'supabase_db_teer-dev',
          'psql',
          '-U',
          'postgres',
          '-d',
          'postgres',
          '-t',
          '-A',
          '-q',
        ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      input: sql,
    },
  );

  return output.trim();
}

function psqlJson(sql) {
  const output = psql(sql);
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const payload = lines.at(-1);

  return payload ? JSON.parse(payload) : null;
}

function digitsOnly(value) {
  return value.replace(/\D/g, '');
}

function normalizeSenegalPhone(value) {
  let digits = digitsOnly(value.trim());

  if (digits.startsWith('00')) {
    digits = digits.slice(2);
  }

  if (digits.startsWith('221')) {
    digits = digits.slice(3);
  }

  if (digits.startsWith('0')) {
    digits = digits.slice(1);
  }

  if (!/^\d{9}$/.test(digits)) {
    return null;
  }

  return `+221${digits}`;
}

function toSenegalNationalDigits(value) {
  if (!value) {
    return '';
  }

  return normalizeSenegalPhone(value)?.slice(4) ?? digitsOnly(value).slice(-9);
}

function stringField(record, key) {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function orderItemsSearchText(itemsSummary) {
  if (!Array.isArray(itemsSummary)) {
    return '';
  }

  const titles = [];

  for (const item of itemsSummary) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const title = stringField(item, 'title');

      if (title) {
        titles.push(title.toLowerCase());
      }
    }
  }

  return titles.join(' ');
}

function normalizeOrderSearch(value) {
  return value?.trim().toLowerCase() ?? '';
}

function matchesOrderSearch(order, rawSearch) {
  const search = normalizeOrderSearch(rawSearch);

  if (!search) {
    return true;
  }

  const searchDigits = digitsOnly(rawSearch);
  const normalizedSearchPhone = normalizeSenegalPhone(rawSearch);
  const customerName = order.customer?.full_name?.toLowerCase() ?? '';
  const productText = orderItemsSearchText(order.items_summary);

  if (customerName.includes(search) || productText.includes(search)) {
    return true;
  }

  const phone = order.customer?.phone;

  if (!phone) {
    return false;
  }

  const normalizedPhone = normalizeSenegalPhone(phone) ?? phone;
  const phoneLower = normalizedPhone.toLowerCase();

  if (normalizedSearchPhone && phoneLower === normalizedSearchPhone.toLowerCase()) {
    return true;
  }

  if (!searchDigits) {
    return phoneLower.includes(search);
  }

  const phoneDigits = digitsOnly(normalizedPhone);
  const nationalDigits = toSenegalNationalDigits(phone);

  return phoneDigits.includes(searchDigits) || nationalDigits.includes(searchDigits);
}

function startOfLocalDay(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function isSameLocalDate(value, date = new Date()) {
  if (!value) {
    return false;
  }

  const target = startOfLocalDay(date);
  const candidate = startOfLocalDay(new Date(value));
  return candidate.getTime() === target.getTime();
}

function queueDate(order) {
  return order.created_at_shopify ?? order.created_at;
}

function matchesOrderSavedView(order, viewId, today = new Date()) {
  switch (viewId) {
    case 'toutes':
      return true;
    case 'a-appeler':
      return order.order_state === 'open' && order.call_state === 'to_call';
    case 'tentee-a-rappeler':
      return order.order_state === 'open' && order.call_state === 'callback';
    case 'confirmee':
      return (
        order.order_state === 'open' &&
        order.call_state === 'validated' &&
        (order.delivery_state === 'unassigned' || order.delivery_state === 'scheduled')
      );
    case 'a-livrer-aujourdhui':
      return (
        (order.delivery_state === 'scheduled' ||
          order.delivery_state === 'assigned' ||
          order.delivery_state === 'out_for_delivery') &&
        isSameLocalDate(order.scheduled_for, today)
      );
    case 'cash-a-remettre':
      return order.cash_state === 'collected';
    case 'annulees':
      return order.order_state === 'cancelled';
    case 'retours':
      return order.order_state === 'returned';
    default:
      return true;
  }
}

function compareOrdersForSavedView(left, right, viewId) {
  if (viewId === 'tentee-a-rappeler') {
    const leftDate = left.next_contact_at ?? queueDate(left);
    const rightDate = right.next_contact_at ?? queueDate(right);
    return leftDate.localeCompare(rightDate);
  }

  return queueDate(right).localeCompare(queueDate(left));
}

async function waitForMerchantAccount(admin, userId) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const { data, error } = await admin
      .from('merchant_account')
      .select('id')
      .eq('owner_user_id', userId)
      .limit(1)
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (data?.id) {
      return data.id;
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error('Merchant account introuvable');
}

function makeCustomers(merchantAccountId, total) {
  const customers = [];

  for (let index = 0; index < total; index += 1) {
    const id = crypto.randomUUID();
    const phoneSuffix = `${770000000 + index}`.slice(-9);
    const special =
      index === 0
        ? {
            full_name: 'Alpha Ndiaye',
            phone: '+221771234567',
          }
        : index === 1
          ? {
              full_name: 'Moussa Diop',
              phone: '+221781112233',
            }
          : {
              full_name: `Client ${index.toString().padStart(4, '0')} Ndiaye`,
              phone: `+221${phoneSuffix}`,
            };

    customers.push({
      id,
      merchant_account_id: merchantAccountId,
      full_name: special.full_name,
      phone: special.phone,
      phone_e164: special.phone,
      created_at: new Date().toISOString(),
      source: 'manual',
      shopify_customer_gids: [],
      first_seen_at: new Date().toISOString(),
    });
  }

  return customers;
}

function makeOrderRow({ createdAt, customerId, index, merchantAccountId, todayIso }) {
  const slot = index % 8;
  const targeted = index % 97 === 0;
  const customerTargeted = index % 211 === 0;
  const itemsTitle = targeted
    ? 'Sac Rare Alpha'
    : index % 5 === 0
      ? 'Montre Dakar'
      : `Produit ${index % 37}`;
  const row = {
    merchant_account_id: merchantAccountId,
    customer_id: customerId,
    order_number: `PH9-${String(index).padStart(5, '0')}`,
    total_amount: 10000 + (index % 19) * 500,
    currency: 'XOF',
    items_summary: [{ title: itemsTitle, quantity: 1, price: 10000 + (index % 19) * 500 }],
    shipping_address: { address1: `Adresse ${index}` },
    source: index % 3 === 0 ? 'shopify' : 'manual',
    created_at: createdAt,
    created_at_shopify: createdAt,
    scheduled_for: null,
    next_contact_at: null,
    order_state: 'open',
    call_state: 'to_call',
    delivery_state: 'unassigned',
    cash_state: 'not_due',
    cod_status: 'A_APPELER',
  };

  switch (slot) {
    case 0:
      break;
    case 1:
      row.call_state = 'callback';
      row.next_contact_at = new Date(Date.parse(createdAt) + 60_000).toISOString();
      row.cod_status = 'TENTEE';
      break;
    case 2:
      row.call_state = 'validated';
      row.cod_status = 'CONFIRMEE';
      break;
    case 3:
      row.call_state = 'validated';
      row.delivery_state = 'scheduled';
      row.scheduled_for = todayIso;
      row.cod_status = 'PROGRAMMEE';
      break;
    case 4:
      row.call_state = 'validated';
      row.delivery_state = 'delivered';
      row.cash_state = 'collected';
      row.cod_status = 'LIVREE';
      break;
    case 5:
      row.order_state = 'cancelled';
      row.call_state = 'validated';
      row.delivery_state = 'scheduled';
      row.cod_status = 'ANNULEE';
      break;
    case 6:
      row.order_state = 'returned';
      row.delivery_state = 'failed';
      row.cash_state = 'discrepancy';
      row.cod_status = 'REFUSEE';
      break;
    case 7:
      row.call_state = customerTargeted ? 'validated' : 'to_call';
      row.delivery_state = customerTargeted ? 'assigned' : 'unassigned';
      row.cod_status = customerTargeted ? 'EN_LIVRAISON' : 'A_APPELER';
      break;
    default:
      break;
  }

  return row;
}

async function insertBatches(client, table, rows, batchSize = 1000) {
  for (let index = 0; index < rows.length; index += batchSize) {
    const batch = rows.slice(index, index + batchSize);
    const { error } = await client.from(table).insert(batch);

    if (error) {
      throw error;
    }
  }
}

async function fetchLegacyOrders(client) {
  const allRows = [];
  let from = 0;

  while (true) {
    const to = from + 999;
    const { data, error } = await client
      .from('orders')
      .select(
        'id, customer_id, order_number, total_amount, currency, cod_status, order_state, call_state, delivery_state, cash_state, items_summary, shipping_address, created_at, created_at_shopify, next_contact_at, scheduled_for, source, sort_at, next_action_at, customer:customer_id(full_name, phone)',
      )
      .order('created_at_shopify', { ascending: false, nullsFirst: false })
      .range(from, to);

    if (error) {
      throw error;
    }

    const rows = data ?? [];
    allRows.push(...rows);

    if (rows.length < 1000) {
      break;
    }

    from += 1000;
  }

  return allRows;
}

function installProofHelpers() {
  psql(`
create or replace function public._phase9_collect_list_orders(
  p_merchant_id uuid,
  p_view text,
  p_search text default null
)
returns jsonb
language plpgsql
as $$
declare
  v_cursor_sort timestamptz := null;
  v_cursor_id uuid := null;
  v_batch_ids uuid[];
  v_batch_count integer;
  v_last_sort timestamptz;
  v_last_id uuid;
  v_ids uuid[] := '{}';
begin
  loop
    with batch as (
      select *
      from public.list_orders_paginated(
        p_merchant_id := p_merchant_id,
        p_view := p_view,
        p_search := p_search,
        p_cursor_sort := v_cursor_sort,
        p_cursor_id := v_cursor_id,
        p_limit := 100
      )
    )
    select
      coalesce(
        array_agg(
          id
          order by
            case when p_view = 'tentee-a-rappeler' then next_action_at end asc nulls last,
            case when p_view = 'tentee-a-rappeler' then id end asc nulls last,
            case when p_view <> 'tentee-a-rappeler' then sort_at end desc nulls last,
            case when p_view <> 'tentee-a-rappeler' then id end desc nulls last
        ),
        '{}'
      ),
      count(*)::integer,
      (
        select case when p_view = 'tentee-a-rappeler' then next_action_at else sort_at end
        from batch
        order by
          case when p_view = 'tentee-a-rappeler' then next_action_at end desc nulls last,
          case when p_view = 'tentee-a-rappeler' then id end desc nulls last,
          case when p_view <> 'tentee-a-rappeler' then sort_at end asc nulls last,
          case when p_view <> 'tentee-a-rappeler' then id end asc nulls last
        limit 1
      ),
      (
        select id
        from batch
        order by
          case when p_view = 'tentee-a-rappeler' then next_action_at end desc nulls last,
          case when p_view = 'tentee-a-rappeler' then id end desc nulls last,
          case when p_view <> 'tentee-a-rappeler' then sort_at end asc nulls last,
          case when p_view <> 'tentee-a-rappeler' then id end asc nulls last
        limit 1
      )
    into v_batch_ids, v_batch_count, v_last_sort, v_last_id
    from batch;

    exit when v_batch_count = 0;

    v_ids := v_ids || v_batch_ids;
    v_cursor_sort := v_last_sort;
    v_cursor_id := v_last_id;

    exit when v_batch_count < 100;
  end loop;

  return to_jsonb(v_ids);
end;
$$;
  `);
}

function withAuthSql(userId, sql) {
  return `
select set_config('request.jwt.claim.sub', '${userId}', false);
select set_config('request.jwt.claim.role', 'authenticated', false);
${sql}
`;
}

function fetchRpcIds(userId, merchantAccountId, search, view) {
  return (
    psqlJson(
      withAuthSql(
        userId,
        `
select public._phase9_collect_list_orders(
  '${merchantAccountId}'::uuid,
  '${view}',
  ${search ? `'${search.replace(/'/g, "''")}'` : 'null'}
)::text;
        `,
      ),
    ) ?? []
  );
}

function fetchRpcCounts(userId, merchantAccountId, search) {
  return psqlJson(
    withAuthSql(
      userId,
      `
select row_to_json(x)::text
from public.orders_view_counts(
  '${merchantAccountId}'::uuid,
  ${search ? `'${search.replace(/'/g, "''")}'` : 'null'}
) as x;
      `,
    ),
  );
}

function explainQuery(sql) {
  return psql(sql);
}

function buildLegacyViewIds(allOrders, search, view) {
  return allOrders
    .filter((order) => matchesOrderSearch(order, search))
    .filter((order) => matchesOrderSavedView(order, view))
    .sort((left, right) => compareOrdersForSavedView(left, right, view))
    .map((order) => order.id);
}

function buildLegacyCounts(allOrders, search) {
  const filtered = allOrders.filter((order) => matchesOrderSearch(order, search));

  return {
    toutes: filtered.filter((order) => matchesOrderSavedView(order, 'toutes')).length,
    a_appeler: filtered.filter((order) => matchesOrderSavedView(order, 'a-appeler')).length,
    tentee_a_rappeler: filtered.filter((order) => matchesOrderSavedView(order, 'tentee-a-rappeler'))
      .length,
    confirmee: filtered.filter((order) => matchesOrderSavedView(order, 'confirmee')).length,
    a_livrer_aujourdhui: filtered.filter((order) =>
      matchesOrderSavedView(order, 'a-livrer-aujourdhui'),
    ).length,
    cash_a_remettre: filtered.filter((order) => matchesOrderSavedView(order, 'cash-a-remettre'))
      .length,
    annulees: filtered.filter((order) => matchesOrderSavedView(order, 'annulees')).length,
    retours: filtered.filter((order) => matchesOrderSavedView(order, 'retours')).length,
  };
}

function firstMismatchIndex(left, right) {
  const max = Math.max(left.length, right.length);

  for (let index = 0; index < max; index += 1) {
    if (left[index] !== right[index]) {
      return index;
    }
  }

  return null;
}

async function main() {
  const statusEnv = parseSupabaseStatusEnv();
  const supabaseUrl = statusEnv.API_URL;
  const anonKey = statusEnv.ANON_KEY;
  const serviceRoleKey = statusEnv.SERVICE_ROLE_KEY;
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const anon = createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const email = `phase9-orders-${Date.now()}-${crypto.randomUUID()}@example.com`;
  let createdUserId = null;

  try {
    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });

    if (createError || !created.user) {
      throw createError ?? new Error('Utilisateur de preuve non cree');
    }

    createdUserId = created.user.id;
    const merchantAccountId = await waitForMerchantAccount(admin, createdUserId);
    installProofHelpers();
    const customers = makeCustomers(merchantAccountId, 500);
    const today = new Date();
    today.setHours(14, 0, 0, 0);
    const todayIso = today.toISOString();

    await insertBatches(admin, 'customer', customers, 250);

    const orders = [];
    const baseTime = Date.parse('2026-06-09T12:00:00.000Z');

    for (let index = 0; index < 20_000; index += 1) {
      const createdAt = new Date(baseTime - index * 60_000).toISOString();
      const customer = customers[index % customers.length];
      orders.push(
        makeOrderRow({
          createdAt,
          customerId: customer.id,
          index,
          merchantAccountId,
          todayIso,
        }),
      );
    }

    await insertBatches(admin, 'orders', orders, 1000);

    const { error: signInError } = await anon.auth.signInWithPassword({ email, password });

    if (signInError) {
      throw signInError;
    }

    const legacyOrders = await fetchLegacyOrders(anon);
    const authDebug = psql(
      withAuthSql(
        createdUserId,
        `
select auth.uid()::text || '|' || coalesce(public.current_member_role('${merchantAccountId}'::uuid), 'NULL');
        `,
      ),
    )
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1);
    const queries = [
      { label: 'empty', value: '' },
      { label: 'name_fragment', value: 'ndi' },
      { label: 'phone_77', value: '771234567' },
      { label: 'phone_e164', value: '+221771234567' },
      { label: 'phone_00221', value: '00221771234567' },
      { label: 'phone_digits_only', value: '221771234567' },
      { label: 'product_title', value: 'sac rare alpha' },
      { label: 'case_variant', value: 'ALPHA' },
    ];

    const raw = await Promise.all(
      queries.map(async (query) => {
        const rpcCounts = fetchRpcCounts(createdUserId, merchantAccountId, query.value);
        const legacyCounts = buildLegacyCounts(legacyOrders, query.value);
        const perView = Object.fromEntries(
          await Promise.all(
            views.map(async (view) => {
              const legacyIds = buildLegacyViewIds(legacyOrders, query.value, view);
              const rpcIds = fetchRpcIds(createdUserId, merchantAccountId, query.value, view);

              return [
                view,
                {
                  firstMismatchIndex: firstMismatchIndex(legacyIds, rpcIds),
                  legacyIds,
                  lengths: {
                    legacy: legacyIds.length,
                    rpc: rpcIds.length,
                  },
                  rpcIds,
                },
              ];
            }),
          ),
        );

        return {
          counts: {
            legacy: legacyCounts,
            rpc: rpcCounts,
          },
          label: query.label,
          query: query.value,
          views: perView,
        };
      }),
    );

    const outputDir = join(tmpdir(), 'teer-phase9');
    mkdirSync(outputDir, { recursive: true });
    const outputPath = join(outputDir, 'orders-diff-raw.json');
    const explainToutesPath = join(outputDir, 'orders-explain-toutes.txt');
    const explainCallbackPath = join(outputDir, 'orders-explain-callback.txt');
    writeFileSync(outputPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');

    const explainToutes = explainQuery(`
explain (analyze, buffers)
select id
from public.orders
where merchant_account_id = '${merchantAccountId}'::uuid
order by sort_at desc, id desc
limit 25;
    `);
    const explainCallback = explainQuery(`
explain (analyze, buffers)
select id
from public.orders
where merchant_account_id = '${merchantAccountId}'::uuid
  and order_state = 'open'
  and call_state = 'callback'
order by next_action_at asc, id asc
limit 25;
    `);
    writeFileSync(explainToutesPath, `${explainToutes}\n`, 'utf8');
    writeFileSync(explainCallbackPath, `${explainCallback}\n`, 'utf8');

    const compact = raw.map((entry) => ({
      counts: entry.counts,
      label: entry.label,
      query: entry.query,
      views: Object.fromEntries(
        Object.entries(entry.views).map(([view, data]) => [
          view,
          {
            firstMismatchIndex: data.firstMismatchIndex,
            lengths: data.lengths,
          },
        ]),
      ),
    }));

    console.log(
      JSON.stringify(
        {
          authDebug,
          explainCallbackPath,
          explainToutesPath,
          outputPath,
          results: compact,
        },
        null,
        2,
      ),
    );
  } finally {
    if (createdUserId) {
      await admin.auth.admin.deleteUser(createdUserId);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
