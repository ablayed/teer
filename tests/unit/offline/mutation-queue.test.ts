import 'fake-indexeddb/auto';
import {
  enqueueMutation,
  flushMutationQueue,
  listQueuedMutations,
  onMutationSettled,
} from '@/lib/offline/mutation-queue';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(async () => {
  const all = await listQueuedMutations();
  await flushMutationQueue(
    Object.fromEntries(all.map((m) => [m.kind, async () => ({ ok: true })])),
  );
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

  it('id explicite (idempotence) : enqueue avec le même id ne crée pas deux entrées', async () => {
    const fixedId = 'fixed-uuid-1';
    await enqueueMutation('create_ad_spend', { amountMinor: 1000 }, fixedId);
    await enqueueMutation('create_ad_spend', { amountMinor: 1000 }, fixedId);

    const all = await listQueuedMutations();
    expect(all.filter((m) => m.id === fixedId)).toHaveLength(1);
  });
});
