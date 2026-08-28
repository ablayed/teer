// @vitest-environment jsdom

import 'fake-indexeddb/auto';

/**
 * Phase F — Lot F2 : `ProductAdSpendForm` doit TOUJOURS créer une ligne
 * produit+arrivage+période+montant — jamais un arrivage optionnel ou choisi par défaut
 * silencieusement quand le contexte est ambigu. Trois scénarios couverts :
 *
 *  (a) `lockedPurchaseLotId` posé (ouverture depuis la Fiche arrivage) → l'arrivage
 *      s'affiche en lecture seule, jamais un `<select>` re-demandant le choix.
 *  (b) `candidateLots` avec plusieurs candidats (ouverture depuis la fiche produit,
 *      lot ambigu) → un `<select>` requis, SANS présélection, et le bouton
 *      « Enregistrer » reste désactivé tant qu'aucun arrivage n'est choisi.
 *  (c) `candidateLots` vide (produit sans arrivage reçu) → message explicite, jamais
 *      de soumission possible (bouton désactivé en permanence).
 *
 * `@/lib/actions/purchases` est un fichier `'use server'` qui importe `env` (validé
 * au chargement du module, cf. CLAUDE.md) — mocké au niveau du seul export utilisé,
 * jamais réellement invoqué dans ces trois tests (aucun ne va jusqu'à la soumission
 * réussie, qui nécessiterait en plus une vraie IndexedDB pour `useQueuedAction`).
 */

import { ProductAdSpendForm } from '@/components/purchases/product-ad-spend-form';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/actions/purchases', () => ({
  createProductAdSpendAction: vi.fn(async () => ({ data: { ok: true, alreadyRecorded: false } })),
}));

afterEach(() => {
  cleanup();
});

describe('ProductAdSpendForm — arrivage verrouillé (ouverture depuis la Fiche arrivage)', () => {
  it('affiche l’arrivage en lecture seule, jamais un select re-demandant le choix', () => {
    render(
      <ProductAdSpendForm
        lockedPurchaseLotId="lot-1"
        lockedPurchaseLotLabel="Fournisseur Wax Import — reçu le 2026-07-28"
        onDone={() => {}}
        productId="prod-1"
      />,
    );

    expect(screen.getByTestId('ad-spend-lot-locked')).toBeTruthy();
    expect(screen.getByText('Fournisseur Wax Import — reçu le 2026-07-28')).toBeTruthy();
    expect(screen.queryByTestId('ad-spend-lot-select')).toBeNull();
    expect(screen.queryByTestId('ad-spend-no-lot')).toBeNull();

    // Le bouton n'est pas bloqué par l'arrivage (déjà connu) — seul le montant reste
    // à saisir pour pouvoir soumettre.
    expect((screen.getByTestId('ad-spend-submit') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('ProductAdSpendForm — plusieurs arrivages candidats (ouverture depuis la fiche produit)', () => {
  it('affiche un select requis sans présélection, bouton désactivé tant que rien n’est choisi', () => {
    render(
      <ProductAdSpendForm
        candidateLots={[
          { id: 'lot-1', label: 'Fournisseur Wax Import — 2026-07-28' },
          { id: 'lot-2', label: 'Fournisseur Bazin Plus — 2026-06-10' },
        ]}
        onDone={() => {}}
        productId="prod-1"
      />,
    );

    const select = screen.getByTestId('ad-spend-lot-select') as HTMLSelectElement;
    expect(select.value).toBe('');
    expect(select.required).toBe(true);

    // Pas de présélection sur plusieurs candidats : le bouton reste désactivé.
    expect((screen.getByTestId('ad-spend-submit') as HTMLButtonElement).disabled).toBe(true);
  });

  it('préselectionne mais affiche quand même l’unique candidat (jamais masqué)', () => {
    render(
      <ProductAdSpendForm
        candidateLots={[{ id: 'lot-1', label: 'Fournisseur Wax Import — 2026-07-28' }]}
        onDone={() => {}}
        productId="prod-1"
      />,
    );

    const select = screen.getByTestId('ad-spend-lot-select') as HTMLSelectElement;
    expect(select.value).toBe('lot-1');
    expect(screen.getByText('Fournisseur Wax Import — 2026-07-28')).toBeTruthy();
  });
});

describe('ProductAdSpendForm — aucun arrivage candidat (produit sans arrivage reçu)', () => {
  it('affiche un message explicite et empêche toute soumission', () => {
    render(<ProductAdSpendForm candidateLots={[]} onDone={() => {}} productId="prod-1" />);

    expect(screen.getByTestId('ad-spend-no-lot')).toBeTruthy();
    expect(screen.queryByTestId('ad-spend-lot-select')).toBeNull();
    expect((screen.getByTestId('ad-spend-submit') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('ProductAdSpendForm — hors ligne (état "queued"), régression Finding 1', () => {
  it('reste ouvert et affiche le libellé "en attente de synchronisation" sans appeler ' +
    'onDone tant que la mutation n’est pas réellement "synced"', async () => {
    const onLineDescriptor = Object.getOwnPropertyDescriptor(window.navigator, 'onLine');
    Object.defineProperty(window.navigator, 'onLine', {
      configurable: true,
      value: false,
    });
    const onDone = vi.fn();

    try {
      render(
        <ProductAdSpendForm
          lockedPurchaseLotId="lot-1"
          lockedPurchaseLotLabel="Fournisseur Wax Import — reçu le 2026-07-28"
          onDone={onDone}
          productId="prod-1"
        />,
      );

      const amountInput = screen.getByPlaceholderText('0');
      fireEvent.change(amountInput, { target: { value: '5000' } });
      fireEvent.blur(amountInput);
      fireEvent.click(screen.getByTestId('ad-spend-submit'));

      // `queued` (posé dans la file IndexedDB durable, PAS encore confirmé par le
      // serveur) : le libellé mandaté doit être VISIBLE, et le formulaire doit
      // rester ouvert — `onDone` ne doit surtout pas avoir été appelé sur ce seul
      // état, sans quoi ce libellé serait inatteignable en pratique (Finding 1).
      await waitFor(() => {
        expect(screen.getByTestId('ad-spend-submit').textContent).toBe(
          "Enregistré sur l'appareil — en attente de synchronisation",
        );
      });
      expect(onDone).not.toHaveBeenCalled();
    } finally {
      if (onLineDescriptor) {
        Object.defineProperty(window.navigator, 'onLine', onLineDescriptor);
      }
    }
  });
});
