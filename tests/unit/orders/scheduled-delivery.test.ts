import {
  SCHEDULED_DELIVERY_STATES,
  hasVisibleScheduledDelivery,
} from '@/lib/orders/scheduled-delivery';
import { describe, expect, it } from 'vitest';

const scheduledFor = '2026-07-24T14:00:00.000Z';

describe('hasVisibleScheduledDelivery', () => {
  it.each(SCHEDULED_DELIVERY_STATES)('affiche la date pour delivery_state=%s', (deliveryState) => {
    expect(hasVisibleScheduledDelivery({ deliveryState, scheduledFor })).toBe(true);
  });

  it.each(['unassigned', 'delivered', 'failed', 'returned'])(
    'masque la date pour delivery_state=%s (valeur historique, non pilotable)',
    (deliveryState) => {
      expect(hasVisibleScheduledDelivery({ deliveryState, scheduledFor })).toBe(false);
    },
  );

  it('masque la date quand scheduled_for est null', () => {
    expect(hasVisibleScheduledDelivery({ deliveryState: 'scheduled', scheduledFor: null })).toBe(
      false,
    );
  });

  it('masque la date quand delivery_state est null', () => {
    expect(hasVisibleScheduledDelivery({ deliveryState: null, scheduledFor })).toBe(false);
  });
});
