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

// Plafond de tentatives avant qu'un enregistrement ne soit « parqué » (retiré du
// rejeu automatique, mais conservé — jamais supprimé silencieusement). 10 est
// généreux pour ce qui est un flush GLOBAL déclenché à chaque navigation ET
// chaque retour réseau (`MutationQueueProvider`) : un échec transitoire (backend
// indisponible quelques minutes) se résorbe largement avant ce seuil, alors
// qu'un échec structurel (lot supprimé, rôle rétrogradé, doublon pré-fix 2a/2b)
// ne se résorbera jamais tout seul — continuer à le rejouer indéfiniment ne fait
// que consommer un aller-retour réseau à chaque page vue, pour toujours, sans
// qu'aucune UI n'existe pour vider la file (cf. CLAUDE.md, Lot F2 finding).
const MAX_ATTEMPTS_BEFORE_PARKING = 10;

export type QueuedMutation<TInput = unknown> = {
  id: string;
  kind: string;
  input: TInput;
  createdAt: string;
  attempts: number;
  lastError?: string;
  // Un enregistrement parqué a atteint MAX_ATTEMPTS_BEFORE_PARKING échecs :
  // `flushMutationQueue` ne le rejoue plus automatiquement, mais NE LE SUPPRIME
  // PAS — il reste inspectable (IndexedDB) pour une investigation manuelle.
  parked?: boolean;
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

// Best-effort : ne doit jamais faire échouer l'appelant si Sentry n'est pas
// disponible (script bloqué, offline) — même motif que le catch silencieux de
// `initMutationQueueAutoFlush` ci-dessous.
function reportParkedMutation(record: QueuedMutation): void {
  void import('@sentry/nextjs')
    .then((Sentry) => {
      Sentry.captureException(new Error('mutation_queue_record_parked'), {
        tags: { module: 'offline.mutation-queue', kind: record.kind },
        extra: { id: record.id, attempts: record.attempts, lastError: record.lastError },
      });
    })
    .catch(() => {});
}

export async function flushMutationQueue(
  executors: Record<string, (input: unknown) => Promise<{ ok: boolean }>>,
): Promise<void> {
  const all = await listQueuedMutations();
  for (const record of all) {
    // Parqué lors d'un flush précédent (plafond de tentatives atteint) : on ne
    // le rejoue plus automatiquement — il reste en base pour investigation
    // manuelle, jamais supprimé silencieusement (cf. commentaire sur `parked`).
    if (record.parked) continue;

    const executor = executors[record.kind];
    if (!executor) continue;

    try {
      const result = await executor(record.input);
      if (result.ok) {
        await withStore('readwrite', (store) => store.delete(record.id));
        notifySettled(record.id);
      } else {
        const attempts = record.attempts + 1;
        const parked = attempts >= MAX_ATTEMPTS_BEFORE_PARKING;
        await withStore('readwrite', (store) =>
          store.put({ ...record, attempts, lastError: 'rejected', parked }),
        );
        if (parked) reportParkedMutation({ ...record, attempts, parked });
      }
    } catch (err) {
      const attempts = record.attempts + 1;
      const parked = attempts >= MAX_ATTEMPTS_BEFORE_PARKING;
      await withStore('readwrite', (store) =>
        store.put({
          ...record,
          attempts,
          lastError: err instanceof Error ? err.message : 'unknown_error',
          parked,
        }),
      );
      if (parked) reportParkedMutation({ ...record, attempts, parked });
    }
  }
}

export function initMutationQueueAutoFlush(
  executors: Record<string, (input: unknown) => Promise<{ ok: boolean }>>,
): () => void {
  // `.catch(() => {})` best-effort : si `indexedDB.open` échoue (site data bloqué,
  // navigateur durci en confidentialité, certaines webviews embarquées), ce flush
  // tourne désormais sur CHAQUE page authentifiée ET chaque retour réseau pour
  // TOUS les utilisateurs (depuis le branchement de MutationQueueProvider à la
  // racine) — sans ce catch, un rejet non observé ici peut produire du bruit
  // (avertissement unhandled-rejection / Sentry) à cette fréquence plutôt que
  // seulement à la soumission d'un formulaire (portée initiale, plus étroite).
  const handleOnline = () => {
    void flushMutationQueue(executors).catch(() => {});
  };
  window.addEventListener('online', handleOnline);
  void flushMutationQueue(executors).catch(() => {}); // rattrape les mutations laissées par une session précédente
  return () => window.removeEventListener('online', handleOnline);
}
