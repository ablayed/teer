import { buildStoreSwitchHref, resolveWorkspaceSection } from '@/lib/workspace/store-switch';
import { describe, expect, it } from 'vitest';

const OLD = '11111111-1111-4111-8111-111111111111';
const NEW = '22222222-2222-4222-8222-222222222222';
const RESOURCE = '33333333-3333-4333-8333-333333333333';

describe('resolveWorkspaceSection', () => {
  it('lit la section d une URL canonique comme d une URL legacy', () => {
    expect(resolveWorkspaceSection(`/s/${OLD}/livreurs`)).toBe('livreurs');
    expect(resolveWorkspaceSection('/livreurs')).toBe('livreurs');
  });

  it('retombe sur tableau à la racine', () => {
    expect(resolveWorkspaceSection('/')).toBe('tableau');
    expect(resolveWorkspaceSection(`/s/${OLD}`)).toBe('tableau');
    expect(resolveWorkspaceSection(`/s/${OLD}/`)).toBe('tableau');
  });
});

describe('buildStoreSwitchHref', () => {
  it('reste sur la MÊME section — le défaut corrigé était un retour à Tableau', () => {
    expect(buildStoreSwitchHref(`/s/${OLD}/livreurs`, NEW)).toBe(`/s/${NEW}/livreurs`);
    expect(buildStoreSwitchHref(`/s/${OLD}/finances`, NEW)).toBe(`/s/${NEW}/finances`);
  });

  it('canonise une URL legacy vers la boutique choisie', () => {
    expect(buildStoreSwitchHref('/livreurs', NEW)).toBe(`/s/${NEW}/livreurs`);
  });

  it('préserve les paramètres de vue, dont ?tab=stock', () => {
    expect(buildStoreSwitchHref(`/s/${OLD}/produits`, NEW, '?tab=stock')).toBe(
      `/s/${NEW}/produits?tab=stock`,
    );
    expect(buildStoreSwitchHref(`/s/${OLD}/commandes`, NEW, 'period=7j&vue=a-appeler')).toBe(
      `/s/${NEW}/commandes?period=7j&vue=a-appeler`,
    );
  });

  it('abandonne un identifiant de ressource porté par un paramètre', () => {
    // `?driver=` désigne un livreur de l'ANCIENNE boutique : le transporter
    // ouvrirait la nouvelle boutique sur une ressource qui ne lui appartient pas.
    expect(buildStoreSwitchHref(`/s/${OLD}/livreurs`, NEW, `?driver=${RESOURCE}&period=30j`)).toBe(
      `/s/${NEW}/livreurs?period=30j`,
    );
  });

  it('abandonne le filtre boutique de l ancienne boutique', () => {
    expect(buildStoreSwitchHref(`/s/${OLD}/commandes`, NEW, `?shop=${OLD}&q=abc`)).toBe(
      `/s/${NEW}/commandes?q=abc`,
    );
  });

  it('retombe au niveau SECTION pour une sous-route à ressource', () => {
    // `/commandes/{id}` : la commande appartient à l'ancienne boutique. On garde
    // la section, jamais la ressource.
    expect(buildStoreSwitchHref(`/s/${OLD}/commandes/${RESOURCE}`, NEW)).toBe(
      `/s/${NEW}/commandes`,
    );
  });

  it('ne produit pas de « ? » orphelin quand tout est filtré', () => {
    expect(buildStoreSwitchHref(`/s/${OLD}/livreurs`, NEW, `?driver=${RESOURCE}`)).toBe(
      `/s/${NEW}/livreurs`,
    );
  });

  it('cible la même boutique sans changer de section (menu ouvert, choix identique)', () => {
    expect(buildStoreSwitchHref(`/s/${OLD}/produits`, OLD, '?tab=stock')).toBe(
      `/s/${OLD}/produits?tab=stock`,
    );
  });
});
