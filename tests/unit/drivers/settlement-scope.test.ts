import { shouldShowTenantCashScopeNote } from '@/lib/drivers/settlement-scope';
import messages from '@/messages/fr.json';
import { describe, expect, it } from 'vitest';

// Cash et versements livreur : portée LOCATAIRE assumée (0064:12-14, 0133:30-32),
// jamais boutique. Ces tests verrouillent le fait que cette portée soit DITE, et
// dite au bon moment — jamais qu'elle soit corrigée.
describe('shouldShowTenantCashScopeNote — /livreurs', () => {
  const at = (accessibleShopCount: number) =>
    shouldShowTenantCashScopeNote({ accessibleShopCount, surface: 'livreurs' });

  it("n'affiche pas l'indice à un marchand mono-boutique (aucune divergence de portée)", () => {
    expect(at(1)).toBe(false);
  });

  it("n'affiche pas l'indice quand le compte n'a aucune boutique accessible", () => {
    expect(at(0)).toBe(false);
  });

  it("affiche l'indice dès la deuxième boutique — le parc est filtré, pas la liste", () => {
    expect(at(2)).toBe(true);
    expect(at(7)).toBe(true);
  });
});

describe('shouldShowTenantCashScopeNote — /finances', () => {
  const at = (shopFilterActive: boolean) =>
    shouldShowTenantCashScopeNote({ shopFilterActive, surface: 'finances' });

  it("n'affiche pas l'indice sans filtre boutique (le sélecteur affiche « Toutes »)", () => {
    expect(at(false)).toBe(false);
  });

  it("affiche l'indice sous filtre boutique actif — même condition que la carte voisine", () => {
    expect(at(true)).toBe(true);
  });
});

describe('microcopie livreurs.settlements (/livreurs)', () => {
  const settlements = messages.livreurs.settlements;

  it('nomme explicitement la portée dans le sous-titre', () => {
    // « tous livreurs confondus » (formulation d'avant 0133) décrivait la seule
    // portée alors possible ; elle ne dit plus rien une fois le parc filtré.
    expect(settlements.subtitle).not.toContain('tous livreurs confondus');
    expect(settlements.subtitle).toContain('tous les livreurs du compte');
  });

  it("dit « toutes boutiques » dans l'indice, et nulle part ailleurs", () => {
    expect(settlements.scopeNoteAllShops).toContain('toutes boutiques');
    expect(settlements.title).not.toContain('boutique');
    expect(settlements.subtitle).not.toContain('boutique');
  });

  it("rappelle dans l'indice que le parc affiché au-dessus, lui, est filtré", () => {
    expect(settlements.scopeNoteAllShops).toContain('boutique active');
  });
});

describe('microcopie finance.kpis — carte « Livreurs concernés » (/finances)', () => {
  const kpis = messages.finance.kpis;

  it('existe en deux variantes, comme la carte voisine « Cash chez les livreurs »', () => {
    expect(kpis.driversConcernedTitle).toBe('Livreurs concernés');
    expect(kpis.driversConcernedAllShopsTitle).toContain('toutes boutiques');
  });

  it('applique le même suffixe de portée que sa voisine, au mot près', () => {
    const suffix = (label: string) => label.slice(label.indexOf('('));
    expect(suffix(kpis.driversConcernedAllShopsTitle)).toBe(suffix(kpis.cashDriversAllShops));
  });

  it("ne dit « boutique » que dans la variante sous filtre, jamais dans l'état par défaut", () => {
    expect(kpis.driversConcernedTitle).not.toContain('boutique');
    expect(kpis.cashDrivers).not.toContain('boutique');
  });
});

describe('registre (lexique de microcopie) — vouvoiement, aucun tutoiement', () => {
  const strings = [
    ...Object.values(messages.livreurs.settlements),
    messages.finance.kpis.driversConcernedTitle,
    messages.finance.kpis.driversConcernedAllShopsTitle,
  ];

  it.each(strings)('« %s »', (value) => {
    expect(value).not.toMatch(/\b(tu|ton|ta|tes|toi)\b/i);
  });
});
