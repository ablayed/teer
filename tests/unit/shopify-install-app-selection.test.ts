// TEST-NONEMBED-01, Test A — sélection d'app sur /api/shopify/install.
//
// Ce fichier REMPLACE `shopify-install-public-refusal.test.ts`, qui verrouillait le refus fermé
// de `teer-public` sur cette route. Ce refus tenait à `embedded = true` ; avec `embedded = false`,
// le flux OAuth `code` redevient le seul chemin vers un jeton hors-ligne et la route doit accepter
// Teer Public. Le fichier n'est pas supprimé pour autant : il reste le seul test qui exerce la
// sélection d'app de cette route, et il porte désormais la garde qui compte.
//
// LA GARDE QUI COMPTE — le seul mode de FAUX SUCCÈS du protocole. `install/route.ts` choisit
// l'app par `?client_id=` et, à défaut, retombe sur l'app par DÉFAUT (Teer Dev). Un appel
// `/api/shopify/install?shop=…` sans `client_id`, joué pour « mesurer Teer Public », installe
// donc Teer Dev : les maillons du protocole sont tous franchis, un jeton est persisté, et la
// mesure ne dit rien de Teer Public — tout en abîmant la fixture. Ce comportement est
// intentionnel (rétrocompatibilité des liens d'install des quatre apps historiques) : il est
// donc verrouillé ici, et non corrigé dans la route.
//
// L'assertion porte sur le `clientId` passé à `buildAuthorizeUrl`, jamais sur l'URL rendue :
// l'URL est mockée et ne porte aucune identité d'app. Un test qui n'inspecterait que la
// redirection serait vert quelle que soit l'app choisie — exactement l'angle mort à fermer.
//
// SHOPIFY-OAUTH-FIRST-01 / B9 — cette route REFUSE désormais toute app publique (D23, option (a),
// T33) et réserve l'installation à `owner`/`manager` (D4, T10). Le cas « accepte Teer Public »
// de Test A est remplacé par son refus ; les apps custom (KOBA et historiques) passent inchangées.
import { buildAuthorizeUrl } from '@/lib/shopify/oauth';
import { signState } from '@/lib/shopify/state';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const authUser = vi.hoisted(() => ({ value: { id: 'user-sentinel' } as { id: string } | null }));
const member = vi.hoisted(() => ({
  value: { merchant_account_id: 'merchant-sentinel', role: 'owner' } as {
    merchant_account_id: string;
    role: string;
  } | null,
}));

const APPS = {
  'teer-dev': {
    label: 'teer-dev' as const,
    clientId: 'dev_client',
    clientSecret: 'dev_secret',
    distribution: 'custom' as const,
  },
  'teer-pilote': {
    label: 'teer-pilote' as const,
    clientId: 'pilote_client',
    clientSecret: 'pilote_secret',
    distribution: 'custom' as const,
  },
  'teer-marchand': {
    label: 'teer-marchand' as const,
    clientId: 'marchand_client',
    clientSecret: 'marchand_secret',
    distribution: 'custom' as const,
  },
  'teer-koba': {
    label: 'teer-koba' as const,
    clientId: 'koba_client',
    clientSecret: 'koba_secret',
    distribution: 'custom' as const,
  },
  'teer-public': {
    label: 'teer-public' as const,
    clientId: 'public_client',
    clientSecret: 'public_secret',
    distribution: 'public' as const,
  },
};

vi.mock('@/lib/actions/merchant', () => ({
  getMerchantMemberForUser: vi.fn(async () => member.value),
  getMerchantAccountById: vi.fn(async (id: string) => ({ id })),
}));

vi.mock('@/lib/shopify/apps', () => ({
  getDefaultShopifyAppOrNull: vi.fn(() => APPS['teer-dev']),
  getShopifyAppByClientId: vi.fn(
    (clientId: string | null) =>
      Object.values(APPS).find((app) => app.clientId === clientId) ?? null,
  ),
}));

vi.mock('@/lib/shopify/oauth', () => ({
  validateShopDomain: vi.fn(() => true),
  buildAuthorizeUrl: vi.fn(() => 'https://acme-shop.myshopify.com/admin/oauth/authorize?mock=1'),
}));

vi.mock('@/lib/shopify/state', () => ({
  generateNonce: vi.fn(() => 'nonce-sentinel'),
  signState: vi.fn(() => 'signed-state-sentinel'),
}));

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: authUser.value } }) },
  })),
}));

const captureException = vi.fn();
const captureMessage = vi.fn();
vi.mock('@sentry/nextjs', () => ({
  captureException: (...args: unknown[]) => captureException(...args),
  captureMessage: (...args: unknown[]) => captureMessage(...args),
}));

function buildRequest(clientId?: string, returnTo?: string) {
  const url = new URL('http://localhost:3000/api/shopify/install');
  url.searchParams.set('shop', 'acme-shop.myshopify.com');
  if (clientId) url.searchParams.set('client_id', clientId);
  if (returnTo) url.searchParams.set('return_to', returnTo);
  return new NextRequest(url);
}

function authorizedClientId(): string | undefined {
  const call = vi.mocked(buildAuthorizeUrl).mock.calls[0];
  return call?.[0]?.clientId;
}

describe('GET /api/shopify/install — l’app autorisée est celle du client_id fourni', () => {
  beforeEach(() => {
    authUser.value = { id: 'user-sentinel' };
    member.value = { merchant_account_id: 'merchant-sentinel', role: 'owner' };
    captureException.mockClear();
    captureMessage.mockClear();
    vi.mocked(buildAuthorizeUrl).mockClear();
    vi.mocked(signState).mockClear();
  });

  // T33 — garde mutée : `if (app.distribution === 'public')`.
  it('T33 : refuse Teer Public AVANT tout state, tout cookie et toute redirection OAuth', async () => {
    const { GET } = await import('@/app/api/shopify/install/route');
    const response = await GET(buildRequest(APPS['teer-public'].clientId));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'app_not_installable_here' });
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(signState).not.toHaveBeenCalled();
    expect(buildAuthorizeUrl).not.toHaveBeenCalled();
  });

  // T10 — garde mutée : `member.role !== 'owner' && member.role !== 'manager'`.
  it('T10 : un agent ne peut pas installer (refus serveur, aucun state)', async () => {
    member.value = { merchant_account_id: 'merchant-sentinel', role: 'agent' };
    const { GET } = await import('@/app/api/shopify/install/route');
    const response = await GET(buildRequest(APPS['teer-koba'].clientId));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'forbidden' });
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(signState).not.toHaveBeenCalled();
    expect(buildAuthorizeUrl).not.toHaveBeenCalled();
  });

  it('T10 (contrôle positif) : un manager installe une app custom', async () => {
    member.value = { merchant_account_id: 'merchant-sentinel', role: 'manager' };
    const { GET } = await import('@/app/api/shopify/install/route');
    const response = await GET(buildRequest(APPS['teer-koba'].clientId));

    expect(response.status).toBe(307);
    expect(authorizedClientId()).toBe('koba_client');
  });

  it('sans espace : vers l’onboarding, aucun state', async () => {
    member.value = null;
    const { GET } = await import('@/app/api/shopify/install/route');
    const response = await GET(buildRequest(APPS['teer-koba'].clientId));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('http://localhost:3000/onboarding');
    expect(buildAuthorizeUrl).not.toHaveBeenCalled();
  });

  it('sans session : connexion avec ce point d’installation, reconstruit à partir de ses seuls paramètres', async () => {
    authUser.value = null;
    const { GET } = await import('@/app/api/shopify/install/route');
    const request = buildRequest(APPS['teer-koba'].clientId, '/parametres?tab=shops&connected=1');
    request.nextUrl.searchParams.set('injected', 'x');
    const response = await GET(new NextRequest(request.nextUrl));
    expect(response.status).toBe(307);
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.pathname).toBe('/connexion');
    const resume = new URL(location.searchParams.get('redirectTo') ?? '', 'http://localhost:3000');
    expect(resume.pathname).toBe('/api/shopify/install');
    expect(Object.fromEntries(resume.searchParams.entries())).toEqual({
      shop: 'acme-shop.myshopify.com',
      client_id: 'koba_client',
      return_to: '/parametres?tab=shops&connected=1',
    });
    expect(buildAuthorizeUrl).not.toHaveBeenCalled();
  });

  it.each(['teer-dev', 'teer-pilote', 'teer-marchand', 'teer-koba'] as const)(
    'autorise %s sous son propre client_id',
    async (label) => {
      const { GET } = await import('@/app/api/shopify/install/route');
      const response = await GET(buildRequest(APPS[label].clientId));

      expect(response.status).toBe(307);
      expect(authorizedClientId()).toBe(APPS[label].clientId);
      expect(captureException).not.toHaveBeenCalled();
    },
  );

  // Le faux succès, verrouillé dans les DEUX sens : ce qui est autorisé est bien Teer Dev, et
  // ce n'est surtout pas Teer Public. La seconde assertion est celle qui rougirait si la route
  // se mettait un jour à deviner l'app depuis autre chose que le `client_id` reçu.
  it('sans client_id, retombe sur Teer Dev — jamais sur Teer Public', async () => {
    const { GET } = await import('@/app/api/shopify/install/route');
    const response = await GET(buildRequest());

    expect(response.status).toBe(307);
    expect(authorizedClientId()).toBe('dev_client');
    expect(authorizedClientId()).not.toBe(APPS['teer-public'].clientId);
  });

  it('refuse un client_id inconnu, sans repli vers une autre app', async () => {
    const { GET } = await import('@/app/api/shopify/install/route');
    const response = await GET(buildRequest('client_id_inconnu'));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'unknown_client_id' });
    expect(buildAuthorizeUrl).not.toHaveBeenCalled();
  });

  it('conserve uniquement le retour externe canonique vers ParamÃ¨tres > Boutiques', async () => {
    const { GET } = await import('@/app/api/shopify/install/route');
    await GET(buildRequest(APPS['teer-koba'].clientId, '/parametres?tab=shops&connected=1'));
    expect(signState).toHaveBeenCalledWith(
      expect.objectContaining({
        returnTo: '/parametres?tab=shops&connected=1',
      }),
    );

    vi.mocked(signState).mockClear();
    await GET(buildRequest(APPS['teer-koba'].clientId, 'https://evil.example/'));
    expect(signState).toHaveBeenCalledWith(expect.objectContaining({ returnTo: undefined }));
  });
});
