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
import { buildAuthorizeUrl } from '@/lib/shopify/oauth';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const APPS = {
  'teer-dev': { label: 'teer-dev' as const, clientId: 'dev_client', clientSecret: 'dev_secret' },
  'teer-pilote': {
    label: 'teer-pilote' as const,
    clientId: 'pilote_client',
    clientSecret: 'pilote_secret',
  },
  'teer-marchand': {
    label: 'teer-marchand' as const,
    clientId: 'marchand_client',
    clientSecret: 'marchand_secret',
  },
  'teer-koba': {
    label: 'teer-koba' as const,
    clientId: 'koba_client',
    clientSecret: 'koba_secret',
  },
  'teer-public': {
    label: 'teer-public' as const,
    clientId: 'public_client',
    clientSecret: 'public_secret',
  },
};

vi.mock('@/lib/actions/merchant', () => ({
  getMerchantAccount: vi.fn(async () => ({ id: 'merchant-sentinel' })),
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
    auth: { getUser: async () => ({ data: { user: { id: 'user-sentinel' } } }) },
  })),
}));

const captureException = vi.fn();
const captureMessage = vi.fn();
vi.mock('@sentry/nextjs', () => ({
  captureException: (...args: unknown[]) => captureException(...args),
  captureMessage: (...args: unknown[]) => captureMessage(...args),
}));

function buildRequest(clientId?: string) {
  const url = new URL('http://localhost:3000/api/shopify/install');
  url.searchParams.set('shop', 'acme-shop.myshopify.com');
  if (clientId) url.searchParams.set('client_id', clientId);
  return new NextRequest(url);
}

function authorizedClientId(): string | undefined {
  const call = vi.mocked(buildAuthorizeUrl).mock.calls[0];
  return call?.[0]?.clientId;
}

describe('GET /api/shopify/install — l’app autorisée est celle du client_id fourni', () => {
  beforeEach(() => {
    captureException.mockClear();
    captureMessage.mockClear();
    vi.mocked(buildAuthorizeUrl).mockClear();
  });

  it('accepte Teer Public et autorise sous SON client_id', async () => {
    const { GET } = await import('@/app/api/shopify/install/route');
    const response = await GET(buildRequest(APPS['teer-public'].clientId));

    expect(response.status).toBe(307);
    expect(authorizedClientId()).toBe('public_client');
    expect(captureException).not.toHaveBeenCalled();
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
});
