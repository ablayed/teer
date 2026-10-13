// L05 — le layout de l'application lance ses lectures indépendantes d'avance.
//
// Deux propriétés, exercées sur le vrai `AppLayout` avec des lectures pilotées à la main :
//   1. départs : ce qui ne dépend pas de l'utilisateur part avant la fin de `getUser` ; le compte
//      marchand part dès que le membre est connu, sans attendre les consentements ;
//   2. priorité des gardes INCHANGÉE : session → consentements → membre → compte onboardé →
//      boutiques. Une lecture lancée d'avance qui échoue ne passe jamais devant une garde
//      antérieure, et son erreur n'est jamais avalée quand son tour arrive.
// Vitest fait échouer la suite sur tout rejet non géré : c'est la garde de `startEarly`.
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Deferred<T> = { promise: Promise<T>; reject: (e: unknown) => void; resolve: (v: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve: (v: T) => void = () => undefined;
  let reject: (e: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

const h = vi.hoisted(() => ({
  calls: [] as string[],
  reads: {} as Record<string, { promise: Promise<unknown> }>,
  storeHeader: null as string | null,
}));

const read = (name: string) => {
  h.calls.push(name);
  return h.reads[name].promise;
};

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: () => read('user') } }),
}));
vi.mock('@/lib/legal/consent', () => ({ getMissingCurrentConsents: () => read('consents') }));
vi.mock('@/lib/actions/merchant', () => ({
  getMerchantAccountById: () => read('account'),
  getMerchantMemberForUser: () => read('member'),
}));
vi.mock('@/lib/workspace/store', () => ({
  defaultWorkspaceStore: (stores: Array<{ isDefault: boolean }>) =>
    stores.find((store) => store.isDefault) ?? null,
  getWorkspaceStores: () => read('stores'),
}));
vi.mock('@/lib/workspace/memberless-destination', () => ({
  resolveMemberlessDestination: () => read('memberless'),
}));
vi.mock('next-intl/server', () => ({ getMessages: () => read('messages') }));
vi.mock('next-intl', () => ({
  NextIntlClientProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('next/headers', () => ({
  headers: async () => {
    h.calls.push('headers');
    return {
      get: (name: string) => (name === 'x-teer-store-id' ? h.storeHeader : null),
    };
  },
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NOT_FOUND');
  },
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));
vi.mock('nuqs/adapters/next/app', () => ({
  NuqsAdapter: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('@/components/analytics-provider', () => ({ AnalyticsProvider: () => null }));
vi.mock('@/components/app-shell/app-shell', () => ({ AppShell: () => null }));
vi.mock('@/components/auth/idle-timeout', () => ({ IdleTimeout: () => null }));
vi.mock('@/components/offline/mutation-queue-provider', () => ({
  MutationQueueProvider: () => null,
}));
vi.mock('@/components/service-worker-register', () => ({ ServiceWorkerRegister: () => null }));

const { default: AppLayout } = await import('@/app/(app)/layout');

const USER = { data: { user: { id: 'user-1' } } };
const NO_USER = { data: { user: null } };
const CONSENTS_OK = { documents: [], ok: true };
const CONSENTS_MISSING = { documents: [{ type: 'cgu' }], ok: true };
const MEMBER = { merchant_account_id: 'account-1', role: 'owner' };
const ACCOUNT = { id: 'account-1', onboarded_at: '2026-01-01T00:00:00.000Z' };
const STORES = [{ id: 'shop-1', isDefault: true, role: 'owner' }];

const tick = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
const r = (name: string) => h.reads[name] as Deferred<unknown>;
const run = () => {
  const result = AppLayout({ children: null });
  // Le test attend le résultat plus bas ; d'ici là, un rejet ne doit pas compter comme non géré.
  result.catch(() => undefined);
  return result;
};

beforeEach(() => {
  h.calls.length = 0;
  h.storeHeader = null;
  for (const name of [
    'user',
    'consents',
    'member',
    'account',
    'stores',
    'memberless',
    'messages',
  ]) {
    h.reads[name] = deferred<unknown>();
  }
  r('messages').resolve({});
});

describe('L05 — départ des lectures du layout', () => {
  it('boutiques, messages et en-têtes partent avant la fin de getUser ; rien qui dépend de l utilisateur', async () => {
    run();
    await tick();
    expect(h.calls).toEqual(expect.arrayContaining(['messages', 'stores', 'headers', 'user']));
    expect(h.calls).not.toContain('consents');
    expect(h.calls).not.toContain('member');
    expect(h.calls).not.toContain('account');
  });

  it('le compte marchand part dès que le membre est connu, consentements encore en cours', async () => {
    run();
    r('user').resolve(USER);
    await tick();
    expect(h.calls).toEqual(expect.arrayContaining(['consents', 'member']));
    expect(h.calls).not.toContain('account');

    r('member').resolve(MEMBER);
    await tick();
    expect(h.calls).toContain('account');
  });

  it('chaque lecture ne part qu une fois sur un rendu complet', async () => {
    const result = run();
    r('user').resolve(USER);
    r('consents').resolve(CONSENTS_OK);
    r('member').resolve(MEMBER);
    r('account').resolve(ACCOUNT);
    r('stores').resolve(STORES);
    await expect(result).resolves.toBeTruthy();
    for (const name of ['user', 'consents', 'member', 'account', 'stores', 'messages', 'headers']) {
      expect(h.calls.filter((call) => call === name)).toHaveLength(1);
    }
    expect(h.calls).not.toContain('memberless');
  });
});

describe('L05 — priorité des gardes inchangée', () => {
  it('sans session : /connexion, même si la lecture des boutiques a échoué entre-temps', async () => {
    const result = run();
    r('stores').reject(new Error('stores_down'));
    r('user').resolve(NO_USER);
    await expect(result).rejects.toThrow('REDIRECT:/connexion');
    expect(h.calls).not.toContain('member');
  });

  it('consentements manquants : /reacceptation passe devant un compte et des boutiques en échec', async () => {
    const result = run();
    r('user').resolve(USER);
    r('stores').reject(new Error('stores_down'));
    r('member').resolve(MEMBER);
    await tick();
    r('account').reject(new Error('account_down'));
    r('consents').resolve(CONSENTS_MISSING);
    await expect(result).rejects.toThrow('REDIRECT:/reacceptation');
  });

  it('lecture des consentements en échec : /reacceptation, comme avant', async () => {
    const result = run();
    r('user').resolve(USER);
    r('member').resolve(MEMBER);
    r('consents').resolve({ ok: false });
    await expect(result).rejects.toThrow('REDIRECT:/reacceptation');
  });

  it('sans appartenance : destination des invitations, aucun compte marchand lu', async () => {
    const result = run();
    r('user').resolve(USER);
    r('consents').resolve(CONSENTS_OK);
    r('member').resolve(null);
    r('memberless').resolve('/invitation');
    await expect(result).rejects.toThrow('REDIRECT:/invitation');
    expect(h.calls).not.toContain('account');
  });

  it('compte non onboardé : /onboarding passe devant des boutiques en échec', async () => {
    const result = run();
    r('user').resolve(USER);
    r('stores').reject(new Error('stores_down'));
    r('consents').resolve(CONSENTS_OK);
    r('member').resolve(MEMBER);
    r('account').resolve({ id: 'account-1', onboarded_at: null });
    await expect(result).rejects.toThrow('REDIRECT:/onboarding');
  });

  it('compte marchand en échec : l erreur remonte à son tour, elle n est pas avalée', async () => {
    const result = run();
    r('user').resolve(USER);
    r('consents').resolve(CONSENTS_OK);
    r('member').resolve(MEMBER);
    await tick();
    r('account').reject(new Error('account_down'));
    r('stores').resolve(STORES);
    await expect(result).rejects.toThrow('account_down');
  });

  it('boutiques en échec : l erreur remonte une fois les gardes antérieures passées', async () => {
    const result = run();
    r('user').resolve(USER);
    r('consents').resolve(CONSENTS_OK);
    r('member').resolve(MEMBER);
    r('account').resolve(ACCOUNT);
    r('stores').reject(new Error('stores_down'));
    await expect(result).rejects.toThrow('stores_down');
  });

  it('aucune boutique : /onboarding ; boutique explicite inaccessible : 404', async () => {
    const empty = run();
    r('user').resolve(USER);
    r('consents').resolve(CONSENTS_OK);
    r('member').resolve(MEMBER);
    r('account').resolve(ACCOUNT);
    r('stores').resolve([]);
    await expect(empty).rejects.toThrow('REDIRECT:/onboarding');

    for (const name of ['user', 'consents', 'member', 'account', 'stores']) {
      h.reads[name] = deferred<unknown>();
    }
    h.storeHeader = 'shop-etranger';
    const foreign = run();
    r('user').resolve(USER);
    r('consents').resolve(CONSENTS_OK);
    r('member').resolve(MEMBER);
    r('account').resolve(ACCOUNT);
    r('stores').resolve(STORES);
    await expect(foreign).rejects.toThrow('NOT_FOUND');
  });
});
