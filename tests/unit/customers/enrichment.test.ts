import {
  REFUSAL_THRESHOLD,
  formatCustomerAddress,
  isRecurringCustomer,
  isRefuserCustomer,
} from '@/lib/customers/enrichment';
import { describe, expect, it } from 'vitest';

describe('formatCustomerAddress', () => {
  it('privilégie le champ raw de l_adresse flexible', () => {
    expect(
      formatCustomerAddress({ raw: 'Cité Keur Gorgui, près de la mosquée', city: 'Dakar' }, null),
    ).toBe('Cité Keur Gorgui, près de la mosquée');
  });

  it('compose repère/quartier/ville/région quand raw est absent', () => {
    expect(
      formatCustomerAddress(
        { raw: null, landmark: 'Face pharmacie', quartier: null, city: 'Thiès', region: 'Thiès' },
        null,
      ),
    ).toBe('Face pharmacie, Thiès, Thiès');
  });

  it('retombe sur l_adresse de livraison Shopify', () => {
    expect(
      formatCustomerAddress(null, {
        address1: 'Rue 10',
        address2: null,
        city: 'Dakar',
        province: 'Dakar',
      }),
    ).toBe('Rue 10, Dakar, Dakar');
  });

  it('retourne null sans donnée exploitable', () => {
    expect(formatCustomerAddress(null, null)).toBeNull();
    expect(formatCustomerAddress({}, {})).toBeNull();
  });
});

describe('isRecurringCustomer / isRefuserCustomer', () => {
  it('récurrent dès la 2e commande', () => {
    expect(isRecurringCustomer(0)).toBe(false);
    expect(isRecurringCustomer(1)).toBe(false);
    expect(isRecurringCustomer(2)).toBe(true);
  });

  it('refuseur au seuil de refus', () => {
    expect(REFUSAL_THRESHOLD).toBe(2);
    expect(isRefuserCustomer(REFUSAL_THRESHOLD - 1)).toBe(false);
    expect(isRefuserCustomer(REFUSAL_THRESHOLD)).toBe(true);
  });
});
