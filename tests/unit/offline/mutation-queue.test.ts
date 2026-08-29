import 'fake-indexeddb/auto';
import {
  enqueueMutation,
  flushMutationQueue,
  listQueuedMutations,
  onMutationSettled,
} from '@/lib/offline/mutation-queue';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(async () => {
  // Ne PAS utiliser flushMutationQueue ici pour nettoyer : un enregistrement
  // `parked` (test du plafond de tentatives) est délibérément ignoré par
  // flushMutationQueue, donc ce nettoyage ne l'atteindrait jamais et le
  // laisserait fuiter vers le test suivant. On vide directement l'object
  // store IndexedDB (fake-indexeddb), sans passer par le comportement métier
  // testé. (`indexedDB.deleteDatabase` a été essayé mais reste bloqué
  // indéfiniment sous fake-indexeddb tant que des connexions ouvertes par
  // mutation-queue.ts — jamais fermées, cf. `openDb` — n'ont pas reçu de
  // `versionchange` traité ; `store.clear()` sur une connexion neuve évite
  // ce blocage.)
  await new Promise<void>((resolve, reject) => {
    const openReq = indexedDB.open('teer-mutation-queue', 1);
    openReq.onupgradeneeded = () => {
      const db = openReq.result;
      if (!db.objectStoreNames.contains('mutations')) {
        db.createObjectStore('mutations', { keyPath: 'id' });
      }
    };
    openReq.onsuccess = () => {
      const db = openReq.result;
      const tx = db.transaction('mutations', 'readwrite');
      tx.objectStore('mutations').clear();
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error);
      };
    };
    openReq.onerror = () => reject(openReq.error);
  });
});

describe('mutation-queue', () => {
  it('enqueue puis flush réussi retire la mutation de la file', async () => {
    const record = await enqueueMutation('set_weight', { lineId: 'l1', weightGrams: 500 });
    expect((await listQueuedMutations()).map((m) => m.id)).toContain(record.id);

    await flushMutationQueue({ set_weight: async () => ({ ok: true }) });

    expect((await listQueuedMutations()).map((m) => m.id)).not.toContain(record.id);
  });

  it('flush en échec laisse la mutation en file avec attempts incrémenté', async () => {
    const record = await enqueueMutation('set_weight', { lineId: 'l1', weightGrams: 500 });
    await flushMutationQueue({ set_weight: async () => ({ ok: false }) });

    const remaining = await listQueuedMutations();
    const found = remaining.find((m) => m.id === record.id);
    expect(found).toBeDefined();
    expect(found?.attempts).toBe(1);
  });

  it('onMutationSettled notifie exactement au retrait de la file (pas avant)', async () => {
    const record = await enqueueMutation('set_weight', { lineId: 'l1', weightGrams: 500 });
    const settled = vi.fn();
    const unsubscribe = onMutationSettled(record.id, settled);

    await flushMutationQueue({ set_weight: async () => ({ ok: false }) });
    expect(settled).not.toHaveBeenCalled();

    await flushMutationQueue({ set_weight: async () => ({ ok: true }) });
    expect(settled).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  it('flush avec un executor qui throw laisse la mutation en file avec lastError', async () => {
    const record = await enqueueMutation('set_weight', { lineId: 'l1', weightGrams: 500 });
    await flushMutationQueue({
      set_weight: async () => {
        throw new Error('network down');
      },
    });

    const remaining = await listQueuedMutations();
    const found = remaining.find((m) => m.id === record.id);
    expect(found).toBeDefined();
    expect(found?.attempts).toBe(1);
    expect(found?.lastError).toBe('network down');
  });

  it('id explicite (idempotence) : enqueue avec le même id ne crée pas deux entrées', async () => {
    const fixedId = 'fixed-uuid-1';
    await enqueueMutation('create_ad_spend', { amountMinor: 1000 }, fixedId);
    await enqueueMutation('create_ad_spend', { amountMinor: 1000 }, fixedId);

    const all = await listQueuedMutations();
    expect(all.filter((m) => m.id === fixedId)).toHaveLength(1);
  });

  it('un enregistrement qui échoue toujours est parqué après le plafond de tentatives, jamais supprimé', async () => {
    const record = await enqueueMutation('set_weight', { lineId: 'l1', weightGrams: 500 });
    const alwaysFailingExecutor = { set_weight: async () => ({ ok: false }) };

    // 10 flushes en échec consécutifs — au-delà du plafond (MAX_ATTEMPTS_BEFORE_PARKING = 10).
    for (let i = 0; i < 10; i++) {
      await flushMutationQueue(alwaysFailingExecutor);
    }

    const afterTenFailures = (await listQueuedMutations()).find((m) => m.id === record.id);
    expect(afterTenFailures).toBeDefined();
    expect(afterTenFailures?.attempts).toBe(10);
    expect(afterTenFailures?.parked).toBe(true);

    // Un exécuteur qui compte ses appels prouve que le rejeu automatique s'est
    // bien arrêté : un enregistrement parqué est ignoré par flushMutationQueue,
    // jamais rejoué, même si un exécuteur qui réussirait est fourni ensuite.
    const callCount = vi.fn(async () => ({ ok: true }));
    await flushMutationQueue({ set_weight: callCount });
    expect(callCount).not.toHaveBeenCalled();

    // Toujours présent en base — jamais supprimé silencieusement.
    const stillPresent = (await listQueuedMutations()).find((m) => m.id === record.id);
    expect(stillPresent).toBeDefined();
    expect(stillPresent?.parked).toBe(true);
  });
});
