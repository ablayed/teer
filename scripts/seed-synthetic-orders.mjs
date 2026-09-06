#!/usr/bin/env node
// UX-COD-01 — jeu de commandes SYNTHÉTIQUE local (~1000 par défaut) pour exercer
// pagination/recherche/filtres sur /commandes à l'échelle observée en prod (1749 commandes,
// dont 1070 A_APPELER — cf. plan UX-COD-01). Jamais contre GETGET SN : garde-fou ci-dessous,
// et le script exige un compte de test DÉDIÉ déjà existant (jamais le compte propriétaire,
// CLAUDE.md règle #14).
//
// Usage :
//   node scripts/seed-synthetic-orders.mjs --email=test@example.com [--count=1000]
//
// L'email doit être un utilisateur local déjà onboardé (voir `pnpm exec playwright` fixtures,
// ou un compte créé à la main sur /connexion en local) — le script résout son
// merchant_account_id et sa boutique par défaut, puis y insère les commandes.
//
// Écrit les 4 dimensions (order_state/call_state/delivery_state/cash_state) ET cod_status —
// même geste que tests/e2e/helpers/visual-fixtures.ts::createOrder — car le trigger
// derive_legacy_cod_status re-dérive cod_status depuis les dimensions à l'insert : les deux
// doivent rester cohérents (CLAUDE.md : "cod_status ne s'écrit jamais directement" en code
// applicatif — ce script est un outil de seed E2E, pas un chemin produit, même statut que les
// fixtures Playwright existantes). Complète aussi order_state_transition par commande, comme
// createOrder(), pour ne pas fausser les vues Tableau qui filtrent sur to_status.

import { createClient } from '@supabase/supabase-js';
import { assertSupabaseHttpTarget } from '../lib/security/supabase-target-policy.ts';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceRoleKey) {
  console.error(
    'seed-synthetic-orders : NEXT_PUBLIC_SUPABASE_URL/SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY requis (voir .env.test).',
  );
  process.exit(1);
}

// Garde-fou — même logique que tests/e2e/helpers/assert-local-supabase.ts, dupliquée ici car
// ce script tourne hors du harness Playwright/TS (plain Node ESM, pas de résolution `@/`).
assertSupabaseHttpTarget({
  target: url,
  variableName: process.env.NEXT_PUBLIC_SUPABASE_URL ? 'NEXT_PUBLIC_SUPABASE_URL' : 'SUPABASE_URL',
  context: 'test',
  serverTarget: process.env.SUPABASE_URL,
  publicTarget: process.env.NEXT_PUBLIC_SUPABASE_URL,
});

if (url === '') {
  console.error(
    `seed-synthetic-orders : GARDE-FOU — URL Supabase non-locale détectée (${url.replace(/\/\/.*@/, '//***@')}). Ce script écrit ~1000 lignes et ne doit JAMAIS tourner contre une base distante/prod.`,
  );
  process.exit(1);
}

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, '').split('=');
    return [key, value ?? true];
  }),
);

const email = args.email;
const count = Number(args.count ?? 1000);

if (!email) {
  console.error('seed-synthetic-orders : --email=<compte de test dédié existant> requis.');
  process.exit(1);
}

const admin = createClient(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Mirroir manuel de lib/domain/order-transition-actions.ts::legacyStatusToDimensions — à
// resynchroniser si cette fonction change (8 statuts fixes, peu de dérive attendue).
const DIMENSIONS_BY_STATUS = {
  A_APPELER: {
    orderState: 'open',
    callState: 'to_call',
    deliveryState: 'unassigned',
    cashState: 'not_due',
    cancelReason: null,
  },
  TENTEE: {
    orderState: 'open',
    callState: 'callback',
    deliveryState: 'unassigned',
    cashState: 'not_due',
    cancelReason: null,
  },
  CONFIRMEE: {
    orderState: 'open',
    callState: 'validated',
    deliveryState: 'unassigned',
    cashState: 'not_due',
    cancelReason: null,
  },
  PROGRAMMEE: {
    orderState: 'open',
    callState: 'validated',
    deliveryState: 'scheduled',
    cashState: 'expected',
    cancelReason: null,
  },
  EN_LIVRAISON: {
    orderState: 'open',
    callState: 'validated',
    deliveryState: 'assigned',
    cashState: 'expected',
    cancelReason: null,
  },
  LIVREE: {
    orderState: 'completed',
    callState: 'validated',
    deliveryState: 'delivered',
    cashState: 'collected',
    cancelReason: null,
  },
  REFUSEE: {
    orderState: 'cancelled',
    callState: 'validated',
    deliveryState: 'failed',
    cashState: 'not_due',
    cancelReason: 'refused',
  },
  ANNULEE: {
    orderState: 'cancelled',
    callState: 'validated',
    deliveryState: 'unassigned',
    cashState: 'not_due',
    cancelReason: 'cancelled',
  },
};

// Distribution grossièrement alignée sur l'audit prod cité par la spec UX-COD-01
// (1749 commandes dont 1070 A_APPELER, très grande majorité à traiter).
const STATUS_WEIGHTS = [
  ['A_APPELER', 0.55],
  ['TENTEE', 0.08],
  ['CONFIRMEE', 0.05],
  ['PROGRAMMEE', 0.06],
  ['EN_LIVRAISON', 0.05],
  ['LIVREE', 0.12],
  ['REFUSEE', 0.05],
  ['ANNULEE', 0.04],
];

const FIRST_NAMES = [
  'Awa',
  'Moussa',
  'Fatou',
  'Ibrahima',
  'Mariama',
  'Ousmane',
  'Aissatou',
  'Cheikh',
  'Khady',
  'Modou',
];
const LAST_NAMES = [
  'Diop',
  'Ndiaye',
  'Fall',
  'Sarr',
  'Ba',
  'Sow',
  'Gueye',
  'Diallo',
  'Cisse',
  'Kane',
];
const PRODUCTS = [
  'Robe wax',
  'Chaussures cuir',
  'Sac a main',
  'Montre homme',
  'Boubou brode',
  'Ecouteurs sans fil',
  'Casque audio',
  'Parfum',
  'Sneakers',
  'Ceinture cuir',
];

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function weightedStatus() {
  const roll = Math.random();
  let acc = 0;
  for (const [status, weight] of STATUS_WEIGHTS) {
    acc += weight;
    if (roll <= acc) return status;
  }
  return STATUS_WEIGHTS[0][0];
}

async function main() {
  const { data: userList, error: userError } = await admin.auth.admin.listUsers({ perPage: 1000 });
  if (userError) throw userError;
  const user = userList.users.find((candidate) => candidate.email === email);
  if (!user) {
    throw new Error(`seed-synthetic-orders : aucun utilisateur local pour ${email}.`);
  }

  const { data: member, error: memberError } = await admin
    .from('merchant_member')
    .select('merchant_account_id')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle();
  if (memberError || !member) {
    throw new Error(`seed-synthetic-orders : aucun merchant_member pour ${email}.`);
  }
  const merchantAccountId = member.merchant_account_id;

  const { data: shop, error: shopError } = await admin
    .from('shop')
    .select('id')
    .eq('merchant_account_id', merchantAccountId)
    .eq('is_default', true)
    .limit(1)
    .maybeSingle();
  if (shopError || !shop) {
    throw new Error(
      `seed-synthetic-orders : aucune boutique par défaut pour ${merchantAccountId}.`,
    );
  }
  const shopId = shop.id;

  // La contrainte CHECK `orders_dispatch_requires_driver` (0057) exige
  // assigned_driver_id NOT NULL dès que delivery_state est 'assigned' ou
  // 'out_for_delivery' — le cas EN_LIVRAISON de ce jeu synthétique. Un livreur
  // dédié à ce seed (rattaché à la boutique via driver_shop, 0133) est créé une
  // seule fois, réutilisé pour tous les lots.
  const { data: existingDriver } = await admin
    .from('driver')
    .select('id')
    .eq('merchant_account_id', merchantAccountId)
    .eq('full_name', 'Livreur Synthétique Seed')
    .maybeSingle();

  let driverId = existingDriver?.id;
  if (!driverId) {
    const { data: driver, error: driverError } = await admin
      .from('driver')
      .insert({
        merchant_account_id: merchantAccountId,
        full_name: 'Livreur Synthétique Seed',
        phone: '+221770000999',
        is_active: true,
      })
      .select('id')
      .single();
    if (driverError) throw driverError;
    driverId = driver.id;

    const { error: driverShopError } = await admin
      .from('driver_shop')
      .insert({ driver_id: driverId, merchant_account_id: merchantAccountId, shop_id: shopId });
    if (driverShopError && !driverShopError.message.includes('duplicate')) throw driverShopError;
  }

  const now = Date.now();
  const batchSize = 200;
  let created = 0;

  for (let batchStart = 0; batchStart < count; batchStart += batchSize) {
    const batchCount = Math.min(batchSize, count - batchStart);

    const customerRows = Array.from({ length: batchCount }, (_, i) => {
      const idx = batchStart + i;
      return {
        merchant_account_id: merchantAccountId,
        shop_id: shopId,
        full_name: `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)} Synth${idx}`,
        phone: `+2217${String(10000000 + idx).slice(0, 8)}`,
        // `customer` n'a pas de colonne `delivery_address` (confirmé par lecture directe du
        // schéma local — seule `orders.shipping_address`, écrite plus bas, porte l'adresse
        // affichée sur la fiche). Retiré : insert échouait avec PGRST204.
      };
    });

    const { data: insertedCustomers, error: customerError } = await admin
      .from('customer')
      .insert(customerRows)
      .select('id');
    if (customerError) throw customerError;

    const orderSeeds = insertedCustomers.map((customer, i) => {
      const idx = batchStart + i;
      const status = weightedStatus();
      const dims = DIMENSIONS_BY_STATUS[status];
      const createdAt = new Date(
        now - Math.floor(Math.random() * 60) * 24 * 60 * 60 * 1000,
      ).toISOString();
      const productTitle = pick(PRODUCTS);
      const price = 5000 + Math.floor(Math.random() * 20) * 500;
      return {
        merchant_account_id: merchantAccountId,
        shop_id: shopId,
        customer_id: customer.id,
        order_number: `SYNTH-${idx}`,
        cod_status: status,
        order_state: dims.orderState,
        call_state: dims.callState,
        delivery_state: dims.deliveryState,
        cash_state: dims.cashState,
        cancel_reason: dims.cancelReason,
        // orders_dispatch_requires_driver (0057) : NOT NULL exigé dès que
        // delivery_state est 'assigned'/'out_for_delivery' (seul EN_LIVRAISON ici).
        assigned_driver_id: ['assigned', 'out_for_delivery'].includes(dims.deliveryState)
          ? driverId
          : null,
        total_amount: price,
        delivery_fee_minor: 1000,
        currency: 'XOF',
        items_summary: [{ title: productTitle, price, quantity: 1 }],
        shipping_address: { address1: `Quartier synth ${idx}`, city: 'Dakar', country: 'SN' },
        created_at: createdAt,
        created_at_shopify: createdAt,
        source: 'appel',
        status, // conservé pour la ligne order_state_transition ci-dessous, retiré avant insert
      };
    });

    const { data: insertedOrders, error: orderError } = await admin
      .from('orders')
      .insert(orderSeeds.map(({ status: _status, ...row }) => row))
      .select('id');
    if (orderError) throw orderError;

    // Miroir de createOrder() (visual-fixtures.ts) : une ligne order_state_transition par
    // commande, sans quoi les vues Tableau qui filtrent sur to_status (En cours de livraison,
    // Annulées/Retours) resteraient vides pour ce jeu synthétique.
    const transitionRows = insertedOrders.map((order, i) => ({
      merchant_account_id: merchantAccountId,
      order_id: order.id,
      from_status: null,
      to_status: orderSeeds[i].status,
      actor_user_id: user.id,
      created_at: orderSeeds[i].created_at,
    }));
    const { error: transitionError } = await admin
      .from('order_state_transition')
      .insert(transitionRows);
    if (transitionError) throw transitionError;

    created += batchCount;
    console.log(`seed-synthetic-orders : ${created}/${count}`);
  }

  console.log(
    `seed-synthetic-orders : terminé — ${created} commandes créées pour ${email} (merchant ${merchantAccountId}, boutique ${shopId}).`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
