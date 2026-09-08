import { decideShopOwnership } from '@/lib/shopify/ownership-guard';
import { describe, expect, it } from 'vitest';

describe('decideShopOwnership', () => {
  it('insère quand aucune boutique n’existe pour ce domaine', () => {
    expect(decideShopOwnership(null, 'tenant-a')).toEqual({ kind: 'insert' });
  });

  it('met à jour quand la boutique existante appartient déjà au tenant demandeur', () => {
    const decision = decideShopOwnership(
      { id: 'shop-1', merchant_account_id: 'tenant-a' },
      'tenant-a',
    );
    expect(decision).toEqual({ kind: 'update', shopId: 'shop-1' });
  });

  it('refuse quand la boutique existante appartient à un autre tenant', () => {
    const decision = decideShopOwnership(
      { id: 'shop-1', merchant_account_id: 'tenant-b' },
      'tenant-a',
    );
    expect(decision).toEqual({ kind: 'refuse' });
  });

  it('refuse dans le sens inverse (le tenant demandeur est le propriétaire d’origine)', () => {
    // Preuve que la comparaison n'est pas orientée par accident (ex. un bug qui refuserait
    // seulement A<-B mais jamais B<-A) : symétrique par construction, testé dans les deux sens.
    const decision = decideShopOwnership(
      { id: 'shop-1', merchant_account_id: 'tenant-a' },
      'tenant-b',
    );
    expect(decision).toEqual({ kind: 'refuse' });
  });
});
