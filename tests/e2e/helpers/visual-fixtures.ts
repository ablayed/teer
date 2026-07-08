import type { OrderStatus } from '@/lib/domain/order-state-machine';
import { legacyStatusToDimensions } from '@/lib/domain/order-transition-actions';
import { type Page, expect } from '@playwright/test';
import {
  adminClient,
  cleanupUsers,
  createConfirmedUser,
  e2ePassword,
  loginViaForm,
  waitForMerchant,
} from './auth';

const FIXED_VISUAL_DATE = '2026-01-15T10:00:00.000Z';

export const visualFixedTime = new Date(FIXED_VISUAL_DATE);

export type VisualFixture = {
  admin: ReturnType<typeof adminClient>;
  email: string;
  merchantAccountId: string;
  userIds: string[];
};

type CustomerSeed = {
  address1: string;
  city?: string;
  fullName: string;
  phone: string;
};

type OrderSeed = {
  address1: string;
  assignedDriverId?: string | null;
  cancelReason?: string | null;
  cashCollectedAt?: string | null;
  cashCollectableMinor?: number;
  createdAt: string;
  createdAtShopify?: string;
  customerId: string;
  deliveryFeeMinor?: number;
  itemsSummary: Array<{ price: number; quantity: number; title: string }>;
  orderNumber: string;
  paymentChannelAtDelivery?: 'ESPECES' | 'WAVE' | 'ORANGE_MONEY' | 'FREE_MONEY' | 'INCONNU';
  returnedAt?: string | null;
  scheduledFor?: string | null;
  source?: string;
  status: OrderStatus;
  totalAmount: number;
};

function visualEmail(label: string): string {
  return `e2e+visual-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

export async function createVisualFixture(label: string): Promise<VisualFixture> {
  const admin = adminClient();
  const email = visualEmail(label);
  const userId = await createConfirmedUser(
    admin,
    email,
    label === 'tableau' ? { userMetadata: { full_name: 'Marchand Visual' } } : undefined,
  );
  const merchantAccountId = await waitForMerchant(admin, userId);

  const { error } = await admin
    .from('merchant_account')
    .update({
      name: `Tëër visuel ${label}`,
      onboarded_at: visualFixedTime.toISOString(),
    })
    .eq('id', merchantAccountId);

  if (error) {
    throw error;
  }

  return {
    admin,
    email,
    merchantAccountId,
    userIds: [userId],
  };
}

export async function cleanupVisualFixture(fixture: VisualFixture): Promise<void> {
  await cleanupUsers(fixture.admin, fixture.userIds);
}

export async function signInToRoute(page: Page, email: string, redirectTo: string): Promise<void> {
  await loginViaForm(page, email, e2ePassword, redirectTo);
  await page.waitForURL(`**${redirectTo}`, { timeout: 45_000 });
  await expect(page.locator('main#main')).toBeVisible({ timeout: 45_000 });
}

export async function waitForFonts(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}

export async function createDriver(
  fixture: VisualFixture,
  seed: { fullName: string; phone: string },
): Promise<string> {
  const { data, error } = await fixture.admin
    .from('driver')
    .insert({
      merchant_account_id: fixture.merchantAccountId,
      full_name: seed.fullName,
      phone: seed.phone,
    })
    .select('id')
    .single();

  if (error) {
    throw error;
  }

  return data.id as string;
}

export async function createProduct(
  fixture: VisualFixture,
  seed: { sku: string; title: string; unitCost?: number },
): Promise<string> {
  const { data, error } = await fixture.admin
    .from('product')
    .insert({
      merchant_account_id: fixture.merchantAccountId,
      sku: seed.sku,
      title: seed.title,
      unit_cost: seed.unitCost ?? 0,
      is_active: true,
    })
    .select('id')
    .single();

  if (error) {
    throw error;
  }

  return data.id as string;
}

export async function createCustomer(fixture: VisualFixture, seed: CustomerSeed): Promise<string> {
  const { data, error } = await fixture.admin
    .from('customer')
    .insert({
      merchant_account_id: fixture.merchantAccountId,
      full_name: seed.fullName,
      phone: seed.phone,
      shipping_address: {
        address1: seed.address1,
        city: seed.city ?? 'Dakar',
        country: 'SN',
      },
    })
    .select('id')
    .single();

  if (error) {
    throw error;
  }

  return data.id as string;
}

export async function createOrder(fixture: VisualFixture, seed: OrderSeed): Promise<string> {
  const dimensions = legacyStatusToDimensions(seed.status);
  const { data, error } = await fixture.admin
    .from('orders')
    .insert({
      merchant_account_id: fixture.merchantAccountId,
      customer_id: seed.customerId,
      order_number: seed.orderNumber,
      total_amount: seed.totalAmount,
      currency: 'XOF',
      cod_status: seed.status,
      order_state: dimensions.orderState,
      call_state: dimensions.callState,
      delivery_state: dimensions.deliveryState,
      cash_state: dimensions.cashState,
      attempt_count: dimensions.attemptCount,
      next_contact_at: dimensions.nextContactAt,
      scheduled_for: seed.scheduledFor ?? dimensions.scheduledFor,
      cancel_reason: seed.cancelReason ?? dimensions.cancelReason,
      assigned_driver_id: seed.assignedDriverId ?? dimensions.assignedDriverId,
      payment_channel_at_delivery: seed.paymentChannelAtDelivery ?? null,
      cash_collected_at: seed.cashCollectedAt ?? null,
      cash_collectable_minor: seed.cashCollectableMinor ?? null,
      delivery_fee_minor: seed.deliveryFeeMinor ?? 0,
      returned_at: seed.returnedAt ?? null,
      ...(seed.source ? { source: seed.source } : {}),
      items_summary: seed.itemsSummary,
      shipping_address: {
        address1: seed.address1,
        city: 'Dakar',
        country: 'SN',
      },
      created_at: seed.createdAt,
      created_at_shopify: seed.createdAtShopify ?? seed.createdAt,
    })
    .select('id')
    .single();

  if (error) {
    throw error;
  }

  // Même raison que orders-transitions.spec.ts::createOrderWithCustomer : ce seed écrit
  // l'état final directement (bypass transition_order), donc order_state_transition reste
  // vide sans cette ligne — cassant le bornage 7j des vues Tableau « En cours de livraison »
  // / « Annulées / Retours » qui lisent order_state_transition.to_status.
  const { data: member } = await fixture.admin
    .from('merchant_member')
    .select('user_id')
    .eq('merchant_account_id', fixture.merchantAccountId)
    .limit(1)
    .maybeSingle();

  if (member?.user_id) {
    await fixture.admin.from('order_state_transition').insert({
      merchant_account_id: fixture.merchantAccountId,
      order_id: data.id,
      from_status: null,
      to_status: seed.status,
      actor_user_id: member.user_id,
      created_at: seed.createdAt,
    });
  }

  return data.id as string;
}

export async function createMatchedCollectedOrder(
  fixture: VisualFixture,
  seed: {
    address1: string;
    cashCollectedAt: string;
    customerId: string;
    orderNumber: string;
    productId: string;
    title: string;
    totalAmount: number;
  },
): Promise<string> {
  const orderId = await createOrder(fixture, {
    address1: seed.address1,
    cashCollectedAt: seed.cashCollectedAt,
    cashCollectableMinor: seed.totalAmount,
    createdAt: seed.cashCollectedAt,
    customerId: seed.customerId,
    itemsSummary: [{ price: seed.totalAmount, quantity: 1, title: seed.title }],
    orderNumber: seed.orderNumber,
    paymentChannelAtDelivery: 'ESPECES',
    status: 'LIVREE',
    totalAmount: seed.totalAmount,
  });

  await fixture.admin.from('order_line').insert({
    merchant_account_id: fixture.merchantAccountId,
    order_id: orderId,
    product_id: seed.productId,
    raw_title: seed.title,
    qty: 1,
    match_status: 'matched',
  });

  return orderId;
}

export async function seedClientsVisualData(fixture: VisualFixture): Promise<void> {
  const driverId = await createDriver(fixture, {
    fullName: 'Ibrahima Diallo',
    phone: '+221770001122',
  });
  const awaCustomerId = await createCustomer(fixture, {
    address1: 'Cité Keur Gorgui',
    fullName: 'Awa Diop',
    phone: '+221771112233',
  });
  const boutiqueCustomerId = await createCustomer(fixture, {
    address1: 'Grand Yoff',
    fullName: 'Boutique Ndiaye',
    phone: '+221778887766',
  });
  const mamadouCustomerId = await createCustomer(fixture, {
    address1: 'Parcelles Assainies',
    fullName: 'Mamadou Fall',
    phone: '+221775551122',
  });

  await createOrder(fixture, {
    address1: 'Cité Keur Gorgui',
    createdAt: '2026-01-15T08:00:00.000Z',
    customerId: awaCustomerId,
    itemsSummary: [{ price: 18000, quantity: 1, title: 'Ensemble wax indigo' }],
    orderNumber: 'CMD-CLT-001',
    status: 'LIVREE',
    totalAmount: 18000,
  });
  await createOrder(fixture, {
    address1: 'Cité Keur Gorgui',
    createdAt: '2026-01-10T09:30:00.000Z',
    customerId: awaCustomerId,
    itemsSummary: [{ price: 22000, quantity: 1, title: 'Sandales de marché' }],
    orderNumber: 'CMD-CLT-002',
    status: 'LIVREE',
    totalAmount: 22000,
  });
  await createOrder(fixture, {
    address1: 'Grand Yoff',
    createdAt: '2026-01-15T09:00:00.000Z',
    customerId: boutiqueCustomerId,
    itemsSummary: [{ price: 14500, quantity: 1, title: 'Sac cabas crème' }],
    orderNumber: 'CMD-CLT-003',
    status: 'A_APPELER',
    totalAmount: 14500,
  });
  await createOrder(fixture, {
    address1: 'Parcelles Assainies',
    assignedDriverId: driverId,
    createdAt: '2026-01-15T09:45:00.000Z',
    customerId: mamadouCustomerId,
    itemsSummary: [{ price: 26500, quantity: 1, title: 'Montre solaire' }],
    orderNumber: 'CMD-CLT-004',
    status: 'EN_LIVRAISON',
    totalAmount: 26500,
  });
}

export async function seedOrdersVisualData(
  fixture: VisualFixture,
): Promise<{ detailOrderId: string; driverId: string }> {
  const driverId = await createDriver(fixture, {
    fullName: 'Ibrahima Diallo',
    phone: '+221770001122',
  });
  const customers = {
    annulee: await createCustomer(fixture, {
      address1: 'Yoff Virage',
      fullName: 'Ndeye Sow',
      phone: '+221770110022',
    }),
    aAppeler: await createCustomer(fixture, {
      address1: 'Guédiawaye',
      fullName: 'Boutique Ndiaye',
      phone: '+221778887766',
    }),
    confirmee: await createCustomer(fixture, {
      address1: 'Mermoz',
      fullName: 'Cheikh Bâ',
      phone: '+221776667788',
    }),
    enLivraison: await createCustomer(fixture, {
      address1: 'Ouest Foire',
      fullName: 'Mamadou Fall',
      phone: '+221775551122',
    }),
    livree: await createCustomer(fixture, {
      address1: 'Liberté 6',
      fullName: 'Awa Diop',
      phone: '+221771112233',
    }),
    programmee: await createCustomer(fixture, {
      address1: 'Sacré-Cœur',
      fullName: 'Aminata Sy',
      phone: '+221779991100',
    }),
    refusee: await createCustomer(fixture, {
      address1: 'Rufisque',
      fullName: 'Ousmane Kane',
      phone: '+221774445566',
    }),
    tentee: await createCustomer(fixture, {
      address1: 'Médina',
      fullName: 'Fatou Seck',
      phone: '+221772223344',
    }),
  };

  await createOrder(fixture, {
    address1: 'Guédiawaye',
    createdAt: '2026-01-15T07:55:00.000Z',
    customerId: customers.aAppeler,
    itemsSummary: [{ price: 14500, quantity: 1, title: 'Sac cabas crème' }],
    orderNumber: 'CMD-VIS-001',
    status: 'A_APPELER',
    totalAmount: 14500,
  });
  await createOrder(fixture, {
    address1: 'Médina',
    createdAt: '2026-01-15T08:10:00.000Z',
    customerId: customers.tentee,
    itemsSummary: [{ price: 19500, quantity: 1, title: 'Robe bazin courte' }],
    orderNumber: 'CMD-VIS-002',
    status: 'TENTEE',
    totalAmount: 19500,
  });
  await createOrder(fixture, {
    address1: 'Mermoz',
    createdAt: '2026-01-15T08:30:00.000Z',
    customerId: customers.confirmee,
    itemsSummary: [{ price: 22000, quantity: 1, title: 'Pack foulard premium' }],
    orderNumber: 'CMD-VIS-003',
    status: 'CONFIRMEE',
    totalAmount: 22000,
  });
  await createOrder(fixture, {
    address1: 'Sacré-Cœur',
    createdAt: '2026-01-15T08:50:00.000Z',
    customerId: customers.programmee,
    itemsSummary: [{ price: 27500, quantity: 1, title: 'Montre solaire' }],
    orderNumber: 'CMD-VIS-004',
    scheduledFor: '2026-01-16T09:00:00.000Z',
    status: 'PROGRAMMEE',
    totalAmount: 27500,
  });
  const detailOrderId = await createOrder(fixture, {
    address1: 'Ouest Foire',
    assignedDriverId: driverId,
    cashCollectableMinor: 31000,
    createdAt: '2026-01-15T09:05:00.000Z',
    customerId: customers.enLivraison,
    deliveryFeeMinor: 3000,
    itemsSummary: [{ price: 31000, quantity: 1, title: 'Sneakers Dakar Run' }],
    orderNumber: 'CMD-VIS-005',
    paymentChannelAtDelivery: 'ESPECES',
    status: 'EN_LIVRAISON',
    totalAmount: 31000,
  });
  await createOrder(fixture, {
    address1: 'Liberté 6',
    assignedDriverId: driverId,
    cashCollectableMinor: 35000,
    createdAt: '2026-01-15T09:20:00.000Z',
    customerId: customers.livree,
    deliveryFeeMinor: 2500,
    itemsSummary: [{ price: 35000, quantity: 1, title: 'Ensemble wax indigo' }],
    orderNumber: 'CMD-VIS-006',
    paymentChannelAtDelivery: 'ESPECES',
    status: 'LIVREE',
    totalAmount: 35000,
  });
  await createOrder(fixture, {
    address1: 'Rufisque',
    cancelReason: 'refused',
    createdAt: '2026-01-15T09:35:00.000Z',
    customerId: customers.refusee,
    itemsSummary: [{ price: 16000, quantity: 1, title: 'Trousse voyage sable' }],
    orderNumber: 'CMD-VIS-007',
    status: 'REFUSEE',
    totalAmount: 16000,
  });
  await createOrder(fixture, {
    address1: 'Yoff Virage',
    cancelReason: 'cancelled',
    createdAt: '2026-01-15T09:50:00.000Z',
    customerId: customers.annulee,
    itemsSummary: [{ price: 14000, quantity: 1, title: 'Bracelet cuir brun' }],
    orderNumber: 'CMD-VIS-008',
    status: 'ANNULEE',
    totalAmount: 14000,
  });

  return { detailOrderId, driverId };
}

export async function seedDriversVisualData(fixture: VisualFixture): Promise<{ driverId: string }> {
  const driverId = await createDriver(fixture, {
    fullName: 'Moussa Ndiaye',
    phone: '+221770009988',
  });
  const customerId = await createCustomer(fixture, {
    address1: 'Sicap Liberté',
    fullName: 'Awa Diop',
    phone: '+221771112233',
  });
  const now = new Date();

  now.setHours(now.getHours() - 2);

  await createOrder(fixture, {
    address1: 'Sicap Liberté',
    assignedDriverId: driverId,
    cashCollectableMinor: 28000,
    createdAt: now.toISOString(),
    customerId,
    deliveryFeeMinor: 2500,
    itemsSummary: [{ price: 28000, quantity: 1, title: 'Pack pagnes premium' }],
    orderNumber: 'CMD-DRV-001',
    paymentChannelAtDelivery: 'ESPECES',
    status: 'LIVREE',
    totalAmount: 28000,
  });

  return { driverId };
}

export async function seedProductsVisualData(fixture: VisualFixture): Promise<void> {
  await createProduct(fixture, {
    sku: 'WAX-001',
    title: 'Ensemble wax indigo',
    unitCost: 18000,
  });
  await createProduct(fixture, {
    sku: 'SAC-014',
    title: 'Sac cabas crème',
    unitCost: 9000,
  });
  await createProduct(fixture, {
    sku: 'MNT-221',
    title: 'Montre solaire',
    unitCost: 12000,
  });
}

export async function seedDashboardVisualData(fixture: VisualFixture): Promise<void> {
  const driverId = await createDriver(fixture, {
    fullName: 'Moussa Ndiaye',
    phone: '+221770009988',
  });
  await createProduct(fixture, {
    sku: 'SAC-014',
    title: 'Sac cabas crème',
    unitCost: 9000,
  });
  await createProduct(fixture, {
    sku: 'MNT-221',
    title: 'Montre solaire',
    unitCost: 12000,
  });
  await createProduct(fixture, {
    sku: 'WAX-001',
    title: 'Ensemble wax indigo',
    unitCost: 18000,
  });
  const customers = {
    aAppeler: await createCustomer(fixture, {
      address1: 'Grand Yoff',
      fullName: 'Boutique Ndiaye',
      phone: '+221778887766',
    }),
    livree: await createCustomer(fixture, {
      address1: 'Liberté 6',
      fullName: 'Awa Diop',
      phone: '+221771112233',
    }),
    programmee: await createCustomer(fixture, {
      address1: 'Sacré-Cœur',
      fullName: 'Aminata Sy',
      phone: '+221779991100',
    }),
  };
  const recentDate = new Date();
  const earlierDate = new Date(recentDate);

  recentDate.setHours(recentDate.getHours() - 4);
  earlierDate.setDate(earlierDate.getDate() - 2);

  await createOrder(fixture, {
    address1: 'Grand Yoff',
    createdAt: recentDate.toISOString(),
    customerId: customers.aAppeler,
    itemsSummary: [{ price: 14500, quantity: 1, title: 'Sac cabas crème' }],
    orderNumber: 'CMD-TBL-001',
    status: 'A_APPELER',
    totalAmount: 14500,
  });
  await createOrder(fixture, {
    address1: 'Liberté 6',
    assignedDriverId: driverId,
    cashCollectedAt: recentDate.toISOString(),
    cashCollectableMinor: 36000,
    createdAt: recentDate.toISOString(),
    customerId: customers.livree,
    deliveryFeeMinor: 2500,
    itemsSummary: [{ price: 36000, quantity: 1, title: 'Ensemble wax indigo' }],
    orderNumber: 'CMD-TBL-002',
    paymentChannelAtDelivery: 'ESPECES',
    status: 'LIVREE',
    totalAmount: 36000,
  });
  await createOrder(fixture, {
    address1: 'Sacré-Cœur',
    createdAt: earlierDate.toISOString(),
    customerId: customers.programmee,
    itemsSummary: [{ price: 27500, quantity: 1, title: 'Montre solaire' }],
    orderNumber: 'CMD-TBL-003',
    scheduledFor: recentDate.toISOString(),
    status: 'PROGRAMMEE',
    totalAmount: 27500,
  });
}

// Plage de période FIGÉE pour Finances + Analyses : on la passe explicitement dans
// l'URL (?from=…&to=…) — comme la baseline commandes-liste — pour que le serveur RSC
// calcule la fenêtre sur des dates fixes au lieu du `now` réel du runner (page.clock
// ne fige que l'horloge navigateur). Toutes les dates de seed tombent dedans.
export async function seedDashboardCashByProductVisualData(
  fixture: VisualFixture,
  productCount: number,
): Promise<void> {
  const customerId = await createCustomer(fixture, {
    address1: 'Liberté 6',
    fullName: 'Awa Diop',
    phone: '+221771112233',
  });

  for (let index = 0; index < productCount; index += 1) {
    const title =
      productCount > 6
        ? `Produit visuel extra long ${index + 1} - edition chaleureuse Dakar`
        : `Produit visuel ${index + 1}`;
    const productId = await createProduct(fixture, {
      sku: `DASH-VIS-${index + 1}`,
      title,
      unitCost: 4_000 + index * 250,
    });

    await createMatchedCollectedOrder(fixture, {
      address1: 'Liberté 6',
      cashCollectedAt: `2026-01-${String(10 + index).padStart(2, '0')}T10:00:00.000Z`,
      customerId,
      orderNumber: `CMD-TBL-CHART-${index + 1}`,
      productId,
      title,
      totalAmount: 12_000 + index * 1_500,
    });
  }
}

export const visualPeriodFrom = '2026-01-01';
export const visualPeriodTo = '2026-01-31';

// Finances (owner) : commandes LIVRÉES + encaissées (cash_collected_at figé janvier
// 2026) avec produit costé + mouvement `sold` → CA / marge / profit non nuls et charts
// tracés (revenue/funnel/boutiques). AUCUN livreur assigné → carte « cash chez les
// livreurs » à 0 (déterministe, zéro settlement comme demandé).
export async function seedFinanceVisualData(fixture: VisualFixture): Promise<void> {
  const userId = fixture.userIds[0];

  const { data: product, error: productError } = await fixture.admin
    .from('product')
    .insert({
      merchant_account_id: fixture.merchantAccountId,
      sku: 'FIN-WAX-001',
      title: 'Ensemble wax indigo',
      unit_cost: 9000,
      is_active: true,
    })
    .select('id')
    .single();

  if (productError || !product) {
    throw productError ?? new Error('seedFinanceVisualData: product insert returned no row');
  }

  const productId = product.id as string;

  await fixture.admin.from('product_stock').upsert(
    {
      product_id: productId,
      merchant_account_id: fixture.merchantAccountId,
      qty_on_hand: 40,
      unit_cost: 9000,
    },
    { onConflict: 'product_id' },
  );

  const collectedOrders = [
    { collectedAt: '2026-01-12T10:00:00.000Z', number: 'FIN-VIS-001', quantity: 2, total: 24000 },
    { collectedAt: '2026-01-20T10:00:00.000Z', number: 'FIN-VIS-002', quantity: 1, total: 18000 },
  ];

  let movementIndex = 0;

  for (const seed of collectedOrders) {
    movementIndex += 1;

    const { data: order, error: orderError } = await fixture.admin
      .from('orders')
      .insert({
        merchant_account_id: fixture.merchantAccountId,
        source: 'shopify',
        order_number: seed.number,
        total_amount: seed.total,
        currency: 'XOF',
        items_summary: [
          {
            price: seed.total / seed.quantity,
            quantity: seed.quantity,
            title: 'Ensemble wax indigo',
          },
        ],
        order_state: 'completed',
        call_state: 'validated',
        delivery_state: 'delivered',
        cash_state: 'collected',
        cash_collected_at: seed.collectedAt,
        created_at: seed.collectedAt,
        payment_channel_at_delivery: 'ESPECES',
      })
      .select('id')
      .single();

    if (orderError || !order) {
      throw orderError ?? new Error('seedFinanceVisualData: order insert returned no row');
    }

    const orderId = order.id as string;

    await fixture.admin.from('order_line').insert({
      merchant_account_id: fixture.merchantAccountId,
      order_id: orderId,
      product_id: productId,
      raw_title: 'Ensemble wax indigo',
      qty: seed.quantity,
      match_status: 'matched',
    });

    await fixture.admin.from('stock_movement').insert({
      merchant_account_id: fixture.merchantAccountId,
      product_id: productId,
      order_id: orderId,
      movement_type: 'sold',
      qty: seed.quantity,
      unit_cost: 9000,
      idempotency_key: `finance-visual-sold-${movementIndex}`,
      created_by: userId,
    });
  }
}

// Analyses (owner/manager) : commandes créées en janvier 2026 aux issues variées
// (livrée / refusée-RTO / annulée) sur deux canaux → scorecard, cartes de synthèse,
// pertes par produit / zone / livreur et raisons peuplés. `trends` est bâti sur la
// fenêtre de jours (Jan 1–31) donc toujours non vide → graphes tracés.
export async function seedAnalyticsVisualData(fixture: VisualFixture): Promise<void> {
  const createdAt = '2026-01-15T10:00:00.000Z';

  const driverId = await createDriver(fixture, {
    fullName: 'Moussa Ndiaye',
    phone: '+221770009988',
  });
  const productId = await createProduct(fixture, {
    sku: 'WAX-001',
    title: 'Ensemble wax indigo',
    unitCost: 9000,
  });
  const awaId = await createCustomer(fixture, {
    address1: 'Liberté 6',
    fullName: 'Awa Diop',
    phone: '+221771112233',
  });
  const ousmaneId = await createCustomer(fixture, {
    address1: 'Rufisque',
    city: 'Rufisque',
    fullName: 'Ousmane Kane',
    phone: '+221774445566',
  });
  const ndeyeId = await createCustomer(fixture, {
    address1: 'Yoff Virage',
    fullName: 'Ndeye Sow',
    phone: '+221770110022',
  });

  const deliveredId = await createOrder(fixture, {
    address1: 'Liberté 6',
    assignedDriverId: driverId,
    cashCollectableMinor: 28000,
    createdAt,
    customerId: awaId,
    deliveryFeeMinor: 2500,
    itemsSummary: [{ price: 28000, quantity: 1, title: 'Ensemble wax indigo' }],
    orderNumber: 'ANA-VIS-001',
    paymentChannelAtDelivery: 'ESPECES',
    source: 'shopify',
    status: 'LIVREE',
    totalAmount: 28000,
  });
  const refusedId = await createOrder(fixture, {
    address1: 'Rufisque',
    assignedDriverId: driverId,
    cancelReason: 'refused',
    createdAt,
    customerId: ousmaneId,
    itemsSummary: [{ price: 16000, quantity: 1, title: 'Ensemble wax indigo' }],
    orderNumber: 'ANA-VIS-002',
    source: 'shopify',
    status: 'REFUSEE',
    totalAmount: 16000,
  });
  await createOrder(fixture, {
    address1: 'Yoff Virage',
    cancelReason: 'cancelled',
    createdAt,
    customerId: ndeyeId,
    itemsSummary: [{ price: 14000, quantity: 1, title: 'Ensemble wax indigo' }],
    orderNumber: 'ANA-VIS-003',
    source: 'manual',
    status: 'ANNULEE',
    totalAmount: 14000,
  });

  // Lignes produit (jointure order_line ↔ produit) pour peupler « Refus par produit ».
  for (const orderId of [deliveredId, refusedId]) {
    await fixture.admin.from('order_line').insert({
      merchant_account_id: fixture.merchantAccountId,
      order_id: orderId,
      product_id: productId,
      raw_title: 'Ensemble wax indigo',
      qty: 1,
      match_status: 'matched',
    });
  }
}
