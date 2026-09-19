import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  exchange: null as
    | { data: { session: { access_token: string } | null }; error: null }
    | { data: { session: null }; error: { message: string } }
    | null,
  exchangeCalls: [] as string[],
}));

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: async () => ({
    auth: {
      exchangeCodeForSession: async (code: string) => {
        harness.exchangeCalls.push(code);
        return harness.exchange;
      },
    },
  }),
}));

const { GET } = await import('@/app/auth/callback/route');

function accessTokenWith(claims: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')}.sig`;
}

const RECOVERY_TOKEN = accessTokenWith({ amr: [{ method: 'recovery' }] });
const PASSWORD_TOKEN = accessTokenWith({ amr: [{ method: 'password' }] });

async function callbackLocation(url: string): Promise<string> {
  const response = await GET(new Request(url) as never);
  return response.headers.get('location') ?? '';
}

beforeEach(() => {
  harness.exchange = { data: { session: { access_token: PASSWORD_TOKEN } }, error: null };
  harness.exchangeCalls = [];
});

describe('rappel de récupération — la destination est FIXE', () => {
  beforeEach(() => {
    harness.exchange = { data: { session: { access_token: RECOVERY_TOKEN } }, error: null };
  });

  it("mène à l'écran de nouveau mot de passe", async () => {
    const location = await callbackLocation('https://www.teerafrik.com/auth/callback?code=abc');

    expect(location).toBe('https://www.teerafrik.com/mot-de-passe-oublie/nouveau');
  });

  it.each([
    ['redirectTo interne', '&redirectTo=%2Fparametres'],
    ['redirectTo absolu', '&redirectTo=https%3A%2F%2Fevil.example%2Fsteal'],
    ['redirectTo protocole-relatif', '&redirectTo=%2F%2Fevil.example'],
    ['redirectTo antislash', '&redirectTo=%2F%5Cevil.example'],
    ['next', '&next=%2Fevil'],
    ['returnTo', '&returnTo=%2Fevil'],
    ['return_to', '&return_to=https%3A%2F%2Fevil.example'],
  ])('AUCUN paramètre de requête ne la déplace — %s', async (_label, injected) => {
    const location = await callbackLocation(
      `https://www.teerafrik.com/auth/callback?code=abc${injected}`,
    );

    // C'est le test le plus important du lot : la destination est lue dans le
    // jeton signé, jamais dans l'URL.
    expect(location).toBe('https://www.teerafrik.com/mot-de-passe-oublie/nouveau');
    expect(location).not.toContain('evil.example');
  });
});

describe('rappel — lien invalide, expiré ou déjà utilisé', () => {
  it.each([
    ['erreur portée par error_code', '?error=access_denied&error_code=otp_expired'],
    ['erreur portée par error seul', '?error=access_denied'],
  ])('mène au message unique, sans échanger quoi que ce soit (%s)', async (_label, query) => {
    const location = await callbackLocation(`https://www.teerafrik.com/auth/callback${query}`);

    expect(location).toBe('https://www.teerafrik.com/connexion?reason=lien_invalide');
    expect(harness.exchangeCalls).toHaveLength(0);
  });

  it("mène au même message quand l'échange échoue (lien ouvert sur un autre appareil)", async () => {
    harness.exchange = {
      data: { session: null },
      error: { message: 'PKCE code verifier not found in storage' },
    };

    const location = await callbackLocation('https://www.teerafrik.com/auth/callback?code=abc');

    expect(location).toBe('https://www.teerafrik.com/connexion?reason=lien_invalide');
  });

  it("ne suit pas un redirectTo injecté à côté d'une erreur", async () => {
    const location = await callbackLocation(
      'https://www.teerafrik.com/auth/callback?error=access_denied&redirectTo=https%3A%2F%2Fevil.example',
    );

    expect(location).toBe('https://www.teerafrik.com/connexion?reason=lien_invalide');
  });
});

describe("rappel — confirmation d'inscription (session ordinaire) : comportement préservé", () => {
  it('honore un redirectTo interne', async () => {
    const location = await callbackLocation(
      'https://www.teerafrik.com/auth/callback?code=abc&redirectTo=%2Fparametres',
    );

    expect(location).toBe('https://www.teerafrik.com/parametres');
  });

  it('retombe sur /tableau sans redirectTo', async () => {
    const location = await callbackLocation('https://www.teerafrik.com/auth/callback?code=abc');

    expect(location).toBe('https://www.teerafrik.com/tableau');
  });

  it.each([
    ['origine étrangère', 'https%3A%2F%2Fevil.example%2Fsteal'],
    ['protocole-relatif', '%2F%2Fevil.example'],
    ['antislash normalisé en //', '%2F%5Cevil.example'],
  ])('refuse une redirection ouverte (%s)', async (_label, injected) => {
    const location = await callbackLocation(
      `https://www.teerafrik.com/auth/callback?code=abc&redirectTo=${injected}`,
    );

    // Le garde local d'origine laissait passer l'antislash : new URL() le normalise
    // en `//evil.example`, donc en changement d'origine. La barrière partagée le rejette.
    expect(location).toBe('https://www.teerafrik.com/tableau');
    expect(location).not.toContain('evil.example');
  });
});
