// File durable générique de mutations, IndexedDB pur (aucune dépendance runtime
// nouvelle — `fake-indexeddb` n'est qu'un devDependency de test). Deux garanties :
// (1) une mutation survit à la fermeture de l'app tant qu'elle n'a pas été
//     confirmée par le serveur (suppression SEULEMENT après ok:true) ;
// (2) un id explicite (fourni par l'appelant, ex. product_ad_spend.external_ref)
//     rend l'enqueue lui-même idempotent — un second enqueue avec le même id
//     écrase l'entrée existante, jamais n'en crée une seconde.
const DB_NAME = 'teer-mutation-queue';
const STORE_NAME = 'mutations';
const DB_VERSION = 1;

export type QueuedMutationStatus = 'queued' | 'synced';

export type QueuedMutation<TInput = unknown> = {
  id: string;
  kind: string;
  input: TInput;
  createdAt: string;
  attempts: number;
  lastError?: string;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const store = tx.objectStore(STORE_NAME);
    const request = fn(store);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function generateId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export async function enqueueMutation<TInput>(
  kind: string,
  input: TInput,
  id?: string,
): Promise<QueuedMutation<TInput>> {
  const record: QueuedMutation<TInput> = {
    id: id ?? generateId(),
    kind,
    input,
    createdAt: new Date().toISOString(),
    attempts: 0,
  };
  await withStore('readwrite', (store) => store.put(record));
  return record;
}

export async function listQueuedMutations(): Promise<QueuedMutation[]> {
  return withStore('readonly', (store) => store.getAll());
}

const settledListeners = new Map<string, Set<() => void>>();

export function onMutationSettled(id: string, handler: () => void): () => void {
  const set = settledListeners.get(id) ?? new Set();
  set.add(handler);
  settledListeners.set(id, set);
  return () => {
    settledListeners.get(id)?.delete(handler);
  };
}

function notifySettled(id: string) {
  for (const handler of settledListeners.get(id) ?? []) handler();
  settledListeners.delete(id);
}

export async function flushMutationQueue(
  executors: Record<string, (input: unknown) => Promise<{ ok: boolean }>>,
): Promise<void> {
  const all = await listQueuedMutations();
  for (const record of all) {
    const executor = executors[record.kind];
    if (!executor) continue;

    try {
      const result = await executor(record.input);
      if (result.ok) {
        await withStore('readwrite', (store) => store.delete(record.id));
        notifySettled(record.id);
      } else {
        await withStore('readwrite', (store) =>
          store.put({ ...record, attempts: record.attempts + 1, lastError: 'rejected' }),
        );
      }
    } catch (err) {
      await withStore('readwrite', (store) =>
        store.put({
          ...record,
          attempts: record.attempts + 1,
          lastError: err instanceof Error ? err.message : 'unknown_error',
        }),
      );
    }
  }
}

export function initMutationQueueAutoFlush(
  executors: Record<string, (input: unknown) => Promise<{ ok: boolean }>>,
): () => void {
  const handleOnline = () => {
    void flushMutationQueue(executors);
  };
  window.addEventListener('online', handleOnline);
  void flushMutationQueue(executors); // rattrape les mutations laissées par une session précédente
  return () => window.removeEventListener('online', handleOnline);
}
