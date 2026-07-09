import { buildDashboardCashCollectedByProduct } from '@/lib/dashboard/cash-by-product';
import { describe, expect, it } from 'vitest';

describe('buildDashboardCashCollectedByProduct', () => {
  it('exclut une commande REFUSEE avec cash_collected_at dans la période si total_amount = 0 malgré items_summary valorisé', () => {
    const result = buildDashboardCashCollectedByProduct({
      orderLines: [
        {
          orderId: 'order-refusee-zero',
          productId: 'product-kit',
          qty: 1,
          rawTitle: 'KIT Adaptateur 5 en 1 - Tous vos câbles en un seul accessoires',
        },
      ],
      orders: [
        {
          id: 'order-refusee-zero',
          itemsSummary: [
            {
              price: 4_900,
              quantity: 1,
              title: 'KIT Adaptateur 5 en 1 - Tous vos câbles en un seul accessoires',
            },
          ],
          totalAmount: 0,
        },
      ],
      products: [
        {
          id: 'product-kit',
          title: 'KIT Adaptateur 5 en 1 - Tous vos câbles en un seul accessoires',
          unitCost: 0,
        },
      ],
    });

    expect(result).toEqual({ items: [], totalMinor: 0 });
  });

  it('exclut une commande LIVREE avec cash_collected_at dans la période si total_amount = 0 malgré items_summary valorisé', () => {
    const result = buildDashboardCashCollectedByProduct({
      orderLines: [
        {
          orderId: 'order-livree-zero',
          productId: 'product-mouse',
          qty: 1,
          rawTitle: 'GSX1- Souris ergonomique sans fil',
        },
      ],
      orders: [
        {
          id: 'order-livree-zero',
          itemsSummary: [
            { price: 11_900, quantity: 1, title: 'GSX1- Souris ergonomique sans fil' },
          ],
          totalAmount: 0,
        },
      ],
      products: [{ id: 'product-mouse', title: 'GSX1- Souris ergonomique sans fil', unitCost: 0 }],
    });

    expect(result).toEqual({ items: [], totalMinor: 0 });
  });

  it('conserve le cas normal si la commande encaissée a total_amount > 0', () => {
    const result = buildDashboardCashCollectedByProduct({
      orderLines: [
        { orderId: 'order-normal', productId: 'product-sac', qty: 1, rawTitle: 'Sac premium' },
      ],
      orders: [
        {
          id: 'order-normal',
          itemsSummary: [{ price: 12_000, quantity: 1, title: 'Sac premium' }],
          totalAmount: 12_000,
        },
      ],
      products: [{ id: 'product-sac', title: 'Sac premium', unitCost: 0 }],
    });

    expect(result).toEqual({
      items: [{ productId: 'product-sac', qtySold: 1, revenueMinor: 12_000, title: 'Sac premium' }],
      totalMinor: 12_000,
    });
  });

  it('n’introduit pas de filtre de statut caché: une commande collectée ensuite REFUSEE avec total_amount > 0 reste incluse', () => {
    const result = buildDashboardCashCollectedByProduct({
      orderLines: [
        {
          orderId: 'order-refusee-positive',
          productId: 'product-card',
          qty: 1,
          rawTitle: 'Gift Card - $10',
        },
      ],
      orders: [
        {
          id: 'order-refusee-positive',
          itemsSummary: [{ price: 10_000, quantity: 1, title: 'Gift Card - $10' }],
          totalAmount: 10_000,
        },
      ],
      products: [{ id: 'product-card', title: 'Gift Card - $10', unitCost: 0 }],
    });

    expect(result).toEqual({
      items: [
        { productId: 'product-card', qtySold: 1, revenueMinor: 10_000, title: 'Gift Card - $10' },
      ],
      totalMinor: 10_000,
    });
  });
});
