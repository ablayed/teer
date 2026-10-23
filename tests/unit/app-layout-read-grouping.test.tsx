import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Deferred<T> = {
  promise: Promise<T>;
  reject: (error: unknown) => void;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
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
  getRequestClaims: async () => {
    const result = (await read('user')) as { data: { user: { id: string } | null } };
    return result.data.user ? { userId: result.data.user.id, email: null } : null;
  },
}));
vi.mock('@/lib/legal/consent', () => ({ getMissingCurrentConsents: () => read('consents') }));
vi.mock('@/lib/workspace/store', () => ({
  defaultWorkspaceStore: (stores: Array<{ isDefault: boolean }>) =>
    stores.find((store) => store.isDefault) ?? null,
  getAppBootstrap: () => read('bootstrap'),
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
    return { get: (name: string) => (name === 'x-teer-store-id' ? h.storeHeader : null) };
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
const BOOTSTRAP = { member: MEMBER, account: ACCOUNT, stores: STORES };

const tick = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
const r = (name: string) => h.reads[name] as Deferred<unknown>;
const run = () => {
  const result = AppLayout({ children: null });
  result.catch(() => undefined);
  return result;
};
const resetReads = () => {
  for (const name of ['user', 'consents', 'bootstrap', 'memberless', 'messages']) {
    h.reads[name] = deferred<unknown>();
  }
  r('messages').resolve({});
};
const resolveAuthenticatedLayout = () => {
  r('user').resolve(USER);
  r('consents').resolve(CONSENTS_OK);
  r('bootstrap').resolve(BOOTSTRAP);
};

beforeEach(() => {
  h.calls.length = 0;
  h.storeHeader = null;
  resetReads();
});

describe('V12b — layout bootstrap', () => {
  it('starts the bootstrap, messages and headers while session lookup is pending', async () => {
    run();
    await tick();
    expect(h.calls).toEqual(expect.arrayContaining(['bootstrap', 'messages', 'headers', 'user']));
    expect(h.calls).not.toContain('consents');
    expect(h.calls).not.toContain('member');
    expect(h.calls).not.toContain('account');
    expect(h.calls).not.toContain('stores');
  });

  it('uses one bootstrap result for member, account and stores', async () => {
    const result = run();
    resolveAuthenticatedLayout();
    await expect(result).resolves.toBeTruthy();
    expect(h.calls.filter((call) => call === 'bootstrap')).toHaveLength(1);
    expect(h.calls).not.toContain('member');
    expect(h.calls).not.toContain('account');
    expect(h.calls).not.toContain('stores');
  });

  it('keeps the session guard ahead of a failed bootstrap', async () => {
    const result = run();
    r('bootstrap').reject(new Error('bootstrap_down'));
    r('user').resolve(NO_USER);
    await expect(result).rejects.toThrow('REDIRECT:/connexion');
    expect(h.calls).not.toContain('consents');
  });

  it('keeps consent reacceptance ahead of a failed bootstrap', async () => {
    const result = run();
    r('user').resolve(USER);
    r('bootstrap').reject(new Error('bootstrap_down'));
    r('consents').resolve(CONSENTS_MISSING);
    await expect(result).rejects.toThrow('REDIRECT:/reacceptation');
  });

  it('keeps reacceptance when the consent read itself fails', async () => {
    const result = run();
    r('user').resolve(USER);
    r('bootstrap').resolve(BOOTSTRAP);
    r('consents').resolve({ ok: false });
    await expect(result).rejects.toThrow('REDIRECT:/reacceptation');
  });

  it('sends a memberless user to the invitation destination', async () => {
    const result = run();
    r('user').resolve(USER);
    r('consents').resolve(CONSENTS_OK);
    r('bootstrap').resolve({ member: null, account: null, stores: [] });
    r('memberless').resolve('/invitation');
    await expect(result).rejects.toThrow('REDIRECT:/invitation');
  });

  it('keeps onboarding ahead of an empty store list', async () => {
    const result = run();
    r('user').resolve(USER);
    r('consents').resolve(CONSENTS_OK);
    r('bootstrap').resolve({
      member: MEMBER,
      account: { ...ACCOUNT, onboarded_at: null },
      stores: [],
    });
    await expect(result).rejects.toThrow('REDIRECT:/onboarding');
  });

  it('does not flatten a failed bootstrap to an empty successful result', async () => {
    const result = run();
    r('user').resolve(USER);
    r('consents').resolve(CONSENTS_OK);
    r('bootstrap').reject(new Error('bootstrap_down'));
    await expect(result).rejects.toThrow('bootstrap_down');
  });

  it('sends a genuinely empty workspace to onboarding and rejects a foreign URL store', async () => {
    const empty = run();
    r('user').resolve(USER);
    r('consents').resolve(CONSENTS_OK);
    r('bootstrap').resolve({ member: MEMBER, account: ACCOUNT, stores: [] });
    await expect(empty).rejects.toThrow('REDIRECT:/onboarding');

    h.calls.length = 0;
    h.storeHeader = 'shop-foreign';
    resetReads();
    const foreign = run();
    resolveAuthenticatedLayout();
    await expect(foreign).rejects.toThrow('NOT_FOUND');
  });
});
