// SHOPIFY-OAUTH-FIRST-01 / B4 — action serveur de rattachement.
//
// Couche : unitaire. L'action est appelée telle qu'elle est exportée (chaîne `requireRole` réelle
// de lib/actions/safe-action.ts) ; seuls la session, les cookies et le cœur sont remplacés. Le
// cœur (`performShopifyClaim`) est prouvé contre PostgreSQL réel dans
// tests/rls/shopify-oauth-first-01.rls.test.ts.
//
// T38 (b) : l'authentification et le rôle sont refaits à chaque appel, quelle que soit l'origine.
// T38 (d) : ticket absent → `ticket_invalid`. Traduction des verdicts (D22, D6, R2/T37).
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  user: { id: 'user-1' } as { id: string } | null,
  member: { id: 'member-1', merchant_account_id: 'account-1', role: 'owner' } as {
    id: string;
    merchant_account_id: string;
    role: string;
  } | null,
  ticket: 'T'.repeat(43) as string | undefined,
  outcome: { kind: 'connected', syncPending: false } as Record<string, unknown>,
  performCalls: [] as Array<Record<string, unknown>>,
  redirects: [] as string[],
  deleted: [] as unknown[],
}));

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('@/lib/security/authz-audit', () => ({ reportAuthorizationFailure: vi.fn() }));
vi.mock('@/lib/env', () => ({
  env: { NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_SERVICE_ROLE_KEY: 'x' },
}));
vi.mock('@/lib/supabase/protected-client', () => ({ createProtectedSupabaseClient: () => ({}) }));
vi.mock('@/lib/shopify/apps', () => ({ getShopifyAppByClientId: () => null }));
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: harness.user } }) },
    from: () => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        limit: () => chain,
        maybeSingle: async () => ({ data: harness.member, error: null }),
      };
      return chain;
    },
  }),
}));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === 'shopify_claim_ticket' && harness.ticket !== undefined
        ? { name, value: harness.ticket }
        : undefined,
    delete: (options: unknown) => harness.deleted.push(options),
  }),
}));
vi.mock('next/navigation', () => ({
  // Erreur de navigation au format de Next : next-safe-action la relance, comme en production.
  redirect: (path: string) => {
    harness.redirects.push(path);
    throw Object.assign(new Error('NEXT_REDIRECT'), {
      digest: `NEXT_REDIRECT;replace;${path};307;`,
    });
  },
}));
vi.mock('@/lib/shopify/claim-core', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/shopify/claim-core')>();
  return {
    ...original,
    performShopifyClaim: async (_admin: unknown, input: Record<string, unknown>) => {
      harness.performCalls.push(input);
      return harness.outcome;
    },
  };
});

async function callAction() {
  const { claimShopifyInstallationAction } = await import('@/lib/actions/shopify-claim');
  try {
    return await claimShopifyInstallationAction({});
  } catch (error) {
    if ((error as { digest?: string }).digest?.startsWith('NEXT_REDIRECT')) return undefined;
    throw error;
  }
}

beforeAll(async () => {
  await import('@/lib/actions/shopify-claim');
}, 60_000);

beforeEach(() => {
  harness.user = { id: 'user-1' };
  harness.member = { id: 'member-1', merchant_account_id: 'account-1', role: 'owner' };
  harness.ticket = 'T'.repeat(43);
  harness.outcome = { kind: 'connected', syncPending: false };
  harness.performCalls.length = 0;
  harness.redirects.length = 0;
  harness.deleted.length = 0;
});

describe('T38 (b) — authentification et rôle refaits à chaque appel', () => {
  it('sans session : refus, cœur jamais appelé', async () => {
    harness.user = null;
    const result = await callAction();
    expect(result?.serverError).toBeDefined();
    expect(harness.performCalls).toEqual([]);
  });

  it('rôle agent : refus, cœur jamais appelé', async () => {
    harness.member = { id: 'member-1', merchant_account_id: 'account-1', role: 'agent' };
    const result = await callAction();
    expect(result?.serverError).toBeDefined();
    expect(harness.performCalls).toEqual([]);
  });

  it('sans appartenance : refus, cœur jamais appelé', async () => {
    harness.member = null;
    await callAction();
    expect(harness.performCalls).toEqual([]);
  });

  for (const role of ['owner', 'manager']) {
    it(`contrôle positif ${role} : utilisateur et espace de la SESSION, ticket du COOKIE`, async () => {
      harness.member = { id: 'member-1', merchant_account_id: 'account-1', role };
      await callAction();
      expect(harness.performCalls).toHaveLength(1);
      expect(harness.performCalls[0]).toMatchObject({
        userId: 'user-1',
        merchantAccountId: 'account-1',
        ticket: 'T'.repeat(43),
      });
    });
  }

  it('l’entrée du client est ignorée : aucun champ ne remplace la session ni le ticket', async () => {
    const { claimShopifyInstallationAction } = await import('@/lib/actions/shopify-claim');
    await claimShopifyInstallationAction({
      merchantAccountId: 'account-forged',
      userId: 'user-forged',
      ticket: 'forged',
    } as never).catch(() => undefined);
    expect(harness.performCalls[0]).toMatchObject({
      userId: 'user-1',
      merchantAccountId: 'account-1',
      ticket: 'T'.repeat(43),
    });
  });
});

describe('B4 — traduction des verdicts', () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['connected', { kind: 'connected', syncPending: false }, '/parametres?tab=shops&connected=1'],
    [
      'T37 connected, effet échoué',
      { kind: 'connected', syncPending: true },
      '/parametres?tab=shops&connected=1&sync=pending',
    ],
    ['D22 already_connected', { kind: 'already_connected' }, '/parametres?tab=shops'],
    ['D6 refused', { kind: 'error', code: 'refused' }, '/shopify/erreur?code=refused'],
    ['forbidden', { kind: 'error', code: 'forbidden' }, '/shopify/erreur?code=forbidden'],
    [
      'T38 (d) ticket_invalid',
      { kind: 'error', code: 'ticket_invalid' },
      '/shopify/erreur?code=ticket_invalid',
    ],
    ['unknown', { kind: 'error', code: 'unknown' }, '/shopify/erreur?code=unknown'],
  ];

  for (const [name, outcome, destination] of cases) {
    it(`${name} → ${destination}, cookie de ticket effacé`, async () => {
      harness.outcome = outcome;
      await callAction();
      expect(harness.redirects).toEqual([destination]);
      expect(harness.deleted).toEqual([{ name: 'shopify_claim_ticket', path: '/shopify/claim' }]);
    });
  }

  it('T37 : un effet échoué n’est jamais une bannière d’échec', async () => {
    harness.outcome = { kind: 'connected', syncPending: true };
    await callAction();
    expect(harness.redirects[0]).not.toMatch(/error|connection_failed|erreur/);
  });

  it('bail tenu : aucune redirection, ticket conservé pour réessayer', async () => {
    harness.outcome = { kind: 'error', code: 'connection_in_progress' };
    const result = await callAction();
    expect(result?.data).toEqual({ ok: false, errorCode: 'connection_in_progress' });
    expect(harness.redirects).toEqual([]);
    expect(harness.deleted).toEqual([]);
  });

  it('T38 (d) : cookie absent → le cœur reçoit un ticket vide, jamais une valeur du client', async () => {
    harness.ticket = undefined;
    harness.outcome = { kind: 'error', code: 'ticket_invalid' };
    await callAction();
    expect(harness.performCalls[0]).toMatchObject({ ticket: undefined });
    expect(harness.redirects).toEqual(['/shopify/erreur?code=ticket_invalid']);
  });
});
