/**
 * PWD-RESET-01 — le parcours de récupération exercé de bout en bout contre le VRAI
 * GoTrue local et la vraie boîte aux lettres de développement.
 *
 * Pourquoi ce fichier existe : les tests unitaires du lot substituent Supabase. Ils
 * prouvent la logique de l'action et la destination du rappel, jamais que GoTrue
 * envoie réellement un courriel, ni quelle FORME prend le lien, ni que le lien est
 * à usage unique, ni ce que devient une session déjà ouverte. Ces propriétés-là ne
 * se déduisent pas d'une documentation : elles se mesurent. C'est la règle du projet
 * — « un test doit exercer l'action réelle, jamais son résultat injecté ».
 *
 * Ce qui est RÉEL ici : `requestPasswordResetAction` jusqu'à son retour, le client
 * `@supabase/ssr` et son stockage PKCE, le transport HTTP vers GoTrue, l'envoi SMTP,
 * le contenu du courriel, l'endpoint `/auth/v1/verify`, le gestionnaire de route
 * `GET /auth/callback`, et la révocation de session côté Supabase.
 *
 * Ce qui est SUBSTITUÉ, et pourquoi : `@/lib/env` (le stack local ne porte pas
 * `RESEND_API_KEY` ; une suite non chargeable ne prouve rien) et `next/headers`
 * (cookies et en-têtes de requête n'existent pas hors d'un contexte Next — le pot de
 * cookies en mémoire tient exactement le rôle du navigateur, y compris pour le
 * vérificateur PKCE). Aucune réponse de GoTrue n'est simulée.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
const APP_URL = 'http://localhost:3000';

function mailpitOrigin(): string {
  const url = new URL(SUPABASE_URL || 'http://127.0.0.1:54321');
  url.port = '54324';
  return url.origin;
}

/** Pot de cookies en mémoire : tient le rôle du navigateur (vérificateur PKCE inclus). */
const cookieJar = new Map<string, string>();

vi.mock('@/lib/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY:
      process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
  },
  publicEnv: {
    NEXT_PUBLIC_SUPABASE_URL: process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY:
      process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
  },
}));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    getAll: () => [...cookieJar.entries()].map(([name, value]) => ({ name, value })),
    set: (name: string, value: string) => {
      cookieJar.set(name, value);
    },
  }),
  headers: async () => new Headers({ 'x-forwarded-for': '198.51.100.24' }),
}));

vi.mock('@/lib/actions/safe-action', () => {
  const builder = {
    metadata: () => builder,
    inputSchema: () => builder,
    action: (handler: unknown) => handler,
  };
  return { actionClient: builder, authActionClient: builder };
});

const { requestPasswordResetAction } = await import('@/lib/actions/password-reset');
const { GET: authCallback } = await import('@/app/auth/callback/route');

type RequestHandler = (args: { parsedInput: { email: string } }) => Promise<{
  ok: boolean;
  errorCode?: string;
}>;
const requestReset = requestPasswordResetAction as unknown as RequestHandler;

const OLD_PASSWORD = 'AncienMotDePasse1!';
const NEW_PASSWORD = 'NouveauMotDePasse2@';

const createdUserIds: string[] = [];

async function adminFetch(path: string, init: RequestInit = {}) {
  return fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

async function createConfirmedUser(email: string): Promise<string> {
  const response = await adminFetch('/auth/v1/admin/users', {
    method: 'POST',
    body: JSON.stringify({ email, password: OLD_PASSWORD, email_confirm: true }),
  });
  const body = (await response.json()) as { id: string };
  createdUserIds.push(body.id);
  return body.id;
}

async function signIn(email: string, password: string) {
  const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, string> };
}

async function clearMailbox() {
  await fetch(`${mailpitOrigin()}/api/v1/messages`, { method: 'DELETE' });
}

async function latestMessageTo(email: string, attempts = 20): Promise<string | null> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const listing = (await (await fetch(`${mailpitOrigin()}/api/v1/messages`)).json()) as {
      messages?: Array<{ ID: string; To?: Array<{ Address?: string }> }>;
    };
    const match = listing.messages?.find((message) =>
      message.To?.some((recipient) => recipient.Address?.toLowerCase() === email.toLowerCase()),
    );
    if (match) {
      const detail = (await (
        await fetch(`${mailpitOrigin()}/api/v1/message/${match.ID}`)
      ).json()) as { Text?: string };
      // Le corps texte est encodé en quoted-printable : on recolle les lignes
      // coupées, sans quoi le lien ressort tronqué (piège mesuré au préflight).
      return String(detail.Text ?? '').replace(/=\r?\n/g, '');
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

function verifyLinkIn(body: string): string | null {
  const match = body.match(/https?:[^\s)]+\/auth\/v1\/verify\?[^\s)]+/);
  return match ? match[0] : null;
}

/** Suit le lien du courriel comme le ferait un navigateur, sans suivre la redirection. */
async function followVerifyLink(link: string): Promise<URL> {
  const response = await fetch(link, { redirect: 'manual' });
  const location = response.headers.get('location');
  expect(location, 'GoTrue doit rediriger vers la cible de rappel').toBeTruthy();
  return new URL(location as string);
}

async function callbackFor(url: URL): Promise<string> {
  const response = await authCallback(new Request(url.toString()) as never);
  return response.headers.get('location') ?? '';
}

/** Jeton d'accès courant, lu dans le pot de cookies comme le ferait le serveur Next. */
async function currentAccessToken(): Promise<string | null> {
  const { createServerClient } = await import('@supabase/ssr');
  const client = createServerClient(SUPABASE_URL, ANON_KEY, {
    cookies: {
      getAll: () => [...cookieJar.entries()].map(([name, value]) => ({ name, value })),
      setAll: (list: Array<{ name: string; value: string }>) => {
        for (const { name, value } of list) {
          cookieJar.set(name, value);
        }
      },
    },
  });
  const {
    data: { session },
  } = await client.auth.getSession();
  return session?.access_token ?? null;
}

beforeAll(() => {
  expect(SUPABASE_URL, 'SUPABASE_URL requis (stack local)').toBeTruthy();
  expect(SERVICE_ROLE_KEY, 'SUPABASE_SERVICE_ROLE_KEY requis').toBeTruthy();
  expect(ANON_KEY, 'SUPABASE_ANON_KEY requis').toBeTruthy();
});

afterAll(async () => {
  for (const id of createdUserIds) {
    await adminFetch(`/auth/v1/admin/users/${id}`, { method: 'DELETE' });
  }
});

describe('PWD-RESET-01 — parcours complet contre le vrai GoTrue', () => {
  it("envoie un lien de récupération, mène à l'écran de nouveau mot de passe, et n'y mène qu'une fois", async () => {
    const email = `pwd-reset-flow-${Date.now()}@example.com`;
    await createConfirmedUser(email);

    // Deux sessions ouvertes AVANT la réinitialisation, pour mesurer leur sort.
    const sessionA = await signIn(email, OLD_PASSWORD);
    const sessionB = await signIn(email, OLD_PASSWORD);
    expect(sessionA.body.access_token).toBeTruthy();
    expect(sessionB.body.access_token).toBeTruthy();

    cookieJar.clear();
    await clearMailbox();

    // 1. L'action réelle.
    const requested = await requestReset({ parsedInput: { email } });
    expect(requested).toEqual({ ok: true });

    // 2. Le courriel est réellement parti, et porte un lien de vérification.
    const body = await latestMessageTo(email);
    expect(body, 'un courriel doit arriver').toBeTruthy();
    const link = verifyLinkIn(body as string);
    expect(link, 'le courriel doit porter un lien /auth/v1/verify').toBeTruthy();

    // 3. FORME du lien, mesurée et non déduite : un jeton PKCE de type `recovery`,
    //    et une cible de rappel strictement égale à celle écrite dans le code.
    const linkUrl = new URL(link as string);
    expect(linkUrl.pathname).toBe('/auth/v1/verify');
    expect(linkUrl.searchParams.get('type')).toBe('recovery');
    expect(linkUrl.searchParams.get('token')).toMatch(/^pkce_/);
    expect(linkUrl.searchParams.get('redirect_to')).toBe(`${APP_URL}/auth/callback`);

    // 4. GoTrue redirige vers notre rappel avec un `code` en QUERY (jamais en
    //    fragment) — c'est ce qui rend le parcours traitable côté serveur.
    const callbackUrl = await followVerifyLink(link as string);
    expect(callbackUrl.pathname).toBe('/auth/callback');
    expect(callbackUrl.searchParams.get('code')).toBeTruthy();
    expect(callbackUrl.hash).toBe('');

    // 5. Le rappel réel mène à l'écran de nouveau mot de passe.
    const destination = await callbackFor(callbackUrl);
    expect(destination).toBe(`${APP_URL}/mot-de-passe-oublie/nouveau`);

    // 6. Le mot de passe est posé sur la session de récupération.
    const recoveryToken = await currentAccessToken();
    expect(recoveryToken, 'la session de récupération doit être installée').toBeTruthy();

    const updated = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      method: 'PUT',
      headers: {
        apikey: ANON_KEY,
        Authorization: `Bearer ${recoveryToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ password: NEW_PASSWORD }),
    });
    expect(updated.status).toBe(200);

    // 7. USAGE UNIQUE — on rejoue le MÊME lien, hors de tout cookie existant.
    //    Sans cette précaution le rejeu semblerait réussir à cause de la session
    //    déjà ouverte, et le test mesurerait le cookie, pas le lien.
    cookieJar.clear();
    const replayUrl = await followVerifyLink(link as string);
    const replayError =
      replayUrl.searchParams.get('error_code') ?? replayUrl.searchParams.get('error');
    expect(replayError, 'un lien rejoué doit être refusé').toBeTruthy();
    expect(await callbackFor(replayUrl)).toBe(`${APP_URL}/connexion?reason=lien_invalide`);

    // 8. SORT DES AUTRES SESSIONS — révoquées par Supabase, sans action de notre part.
    for (const session of [sessionA, sessionB]) {
      const probe = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { apikey: ANON_KEY, Authorization: `Bearer ${session.body.access_token}` },
      });
      expect(probe.status, 'les sessions antérieures doivent être coupées').toBe(403);
    }

    // 9. Le nouveau mot de passe fonctionne, l'ancien non.
    expect((await signIn(email, NEW_PASSWORD)).status).toBe(200);
    expect((await signIn(email, OLD_PASSWORD)).status).toBe(400);
  }, 60_000);

  it("rend la même réponse et n'envoie aucun courriel pour une adresse inconnue", async () => {
    cookieJar.clear();
    await clearMailbox();

    const unknownEmail = `jamais-inscrit-${Date.now()}@example.com`;
    const result = await requestReset({ parsedInput: { email: unknownEmail } });

    // Même objet que pour une adresse existante (cas 1 ci-dessus).
    expect(result).toEqual({ ok: true });

    // Et rien ne part — donc rien ne distingue les deux cas côté public.
    expect(await latestMessageTo(unknownEmail, 8)).toBeNull();
  }, 30_000);
});
