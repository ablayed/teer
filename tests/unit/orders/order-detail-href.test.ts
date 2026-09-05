import { buildOrderDetailHref } from '@/lib/workspace/store-switch';
import { describe, expect, it } from 'vitest';

describe('URL de fiche indépendante de la fiche courante', () => {
  const shop = '6acc6256-19eb-4c25-8d1b-913294fdad2b';
  const a = '63380eca-ceff-4998-b54d-b115b56699ac';
  const b = '5421f462-ba29-4fca-a410-7232e1e4e9ea';

  for (const root of ['/commandes', `/s/${shop}/commandes`]) {
    it(`conserve la racine ${root} après A puis B`, () => {
      expect(buildOrderDetailHref(root, a)).toBe(`${root}/${a}`);
      expect(buildOrderDetailHref(`${root}/${a}`, b)).toBe(`${root}/${b}`);
      expect(buildOrderDetailHref(`${root}/${b}`, a)).toBe(`${root}/${a}`);
      expect(buildOrderDetailHref(`${root}/`, b)).toBe(`${root}/${b}`);
    });
  }
});
