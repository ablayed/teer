import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  rateLimitOk: true,
  rateLimitCalls: [] as Array<{ name: string; key: string }>,
  resetCalls: [] as Array<{ email: string; options?: { redirectTo?: string } }>,
  resetError: null as { message: string; status?: number; code?: string } | null,
  sentryCalls: [] as unknown[],
  requestHeaders: new Headers({ 'x-forwarded-for': '203.0.113.7' }),
}));

vi.mock('@/lib/actions/safe-action', () => {
  const builder = {
    metadata: () => builder,
    inputSchema: (schema: unknown) => {
      // On conserve le schéma pour pouvoir prouver ce qu'il accepte (et rejette).
      const withSchema = {
        ...builder,
        action: (handler: (args: { parsedInput: unknown }) => unknown) =>
          Object.assign(handler, { __schema: schema }),
      };
      return withSchema;
    },
    action: (handler: unknown) => handler,
  };
  return { actionClient: builder, authActionClient: builder };
});

vi.mock('@/lib/env', () => ({
  env: { NEXT_PUBLIC_APP_URL: 'https://www.teerafrik.com' },
}));

vi.mock('@/lib/security/auth-rate-limit', () => ({
  checkAuthRateLimit: async (name: string, key: string) => {
    harness.rateLimitCalls.push({ name, key });
    return { ok: harness.rateLimitOk };
  },
  getClientIp: (headers: Headers) => headers.get('x-forwarded-for') ?? 'unknown',
}));

vi.mock('next/headers', () => ({
  headers: async () => harness.requestHeaders,
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: (error: unknown) => {
    harness.sentryCalls.push(error);
  },
}));

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: async () => ({
    auth: {
      resetPasswordForEmail: async (email: string, options?: { redirectTo?: string }) => {
        harness.resetCalls.push({ email, options });
        return { data: {}, error: harness.resetError };
      },
    },
  }),
}));

const { requestPasswordResetAction } = await import('@/lib/actions/password-reset');

type Handler = (args: { parsedInput: { email: string } }) => Promise<{
  ok: boolean;
  errorCode?: string;
}>;
const requestReset = requestPasswordResetAction as unknown as Handler;

beforeEach(() => {
  harness.rateLimitOk = true;
  harness.rateLimitCalls = [];
  harness.resetCalls = [];
  harness.resetError = null;
  harness.sentryCalls = [];
  harness.requestHeaders = new Headers({ 'x-forwarded-for': '203.0.113.7' });
});

describe('requestPasswordResetAction — réponse indifférenciée', () => {
  it('rend EXACTEMENT le même objet pour une adresse existante et une adresse inconnue', async () => {
    // Le doublure n'a aucune notion de compte : c'est précisément le point. Le code
    // de production ne consulte jamais la base, donc les deux appels ne peuvent pas
    // diverger. On fige la propriété pour qu'un futur `if (userExists)` la casse.
    const existing = await requestReset({ parsedInput: { email: 'proprietaire@example.com' } });
    const unknown = await requestReset({ parsedInput: { email: 'jamais-inscrit@example.com' } });

    expect(existing).toEqual({ ok: true });
    expect(unknown).toEqual({ ok: true });
    expect(existing).toEqual(unknown);
  });

  it('rend la MÊME réponse neutre quand le fournisseur tombe, et journalise côté serveur', async () => {
    harness.resetError = { message: 'smtp unreachable', status: 500 };

    const result = await requestReset({ parsedInput: { email: 'proprietaire@example.com' } });

    expect(result).toEqual({ ok: true });
    // La panne est visible pour nous, jamais pour le public.
    expect(harness.sentryCalls).toHaveLength(1);
  });

  it('avale la limite par UTILISATEUR de Supabase — la remonter révélerait le compte', async () => {
    // L'intervalle de 26 s est par utilisateur : un message distinct prouverait
    // qu'un envoi a été tenté, donc que l'adresse existe.
    harness.resetError = {
      message: 'For security purposes, you can only request this after 26 seconds',
      status: 429,
    };

    const result = await requestReset({ parsedInput: { email: 'proprietaire@example.com' } });

    expect(result).toEqual({ ok: true });
    expect(result.errorCode).toBeUndefined();
  });
});

describe('requestPasswordResetAction — limitation par IP', () => {
  it('annonce distinctement la limite LOCALE par IP, seul cas autorisé', async () => {
    harness.rateLimitOk = false;

    const result = await requestReset({ parsedInput: { email: 'proprietaire@example.com' } });

    expect(result).toEqual({ ok: false, errorCode: 'rate_limited' });
  });

  it("clé sur l'IP de l'appelant, jamais sur l'adresse e-mail", async () => {
    await requestReset({ parsedInput: { email: 'proprietaire@example.com' } });

    expect(harness.rateLimitCalls).toEqual([{ name: 'password_reset', key: '203.0.113.7' }]);
    expect(harness.rateLimitCalls[0]?.key).not.toContain('@');
  });

  it('refuse AVANT tout appel au fournisseur — aucun courriel ne part sous limitation', async () => {
    harness.rateLimitOk = false;

    await requestReset({ parsedInput: { email: 'proprietaire@example.com' } });

    expect(harness.resetCalls).toHaveLength(0);
  });
});

describe('requestPasswordResetAction — destination fixe', () => {
  it("envoie toujours vers /auth/callback, construit depuis l'environnement", async () => {
    await requestReset({ parsedInput: { email: 'proprietaire@example.com' } });

    expect(harness.resetCalls[0]?.options?.redirectTo).toBe(
      'https://www.teerafrik.com/auth/callback',
    );
  });

  it("n'accepte AUCUN paramètre de destination : le schéma ne retient que l'adresse", () => {
    const schema = (
      requestPasswordResetAction as unknown as { __schema: { parse: (v: unknown) => unknown } }
    ).__schema;

    const parsed = schema.parse({
      email: 'proprietaire@example.com',
      next: '/evil',
      redirectTo: 'https://evil.example',
      returnTo: '/evil',
    }) as Record<string, unknown>;

    expect(parsed).toEqual({ email: 'proprietaire@example.com' });
    expect(parsed.next).toBeUndefined();
    expect(parsed.redirectTo).toBeUndefined();
    expect(parsed.returnTo).toBeUndefined();
  });

  it('la destination ne dépend pas des champs injectés dans la requête', async () => {
    await requestReset({
      parsedInput: {
        email: 'proprietaire@example.com',
        redirectTo: 'https://evil.example/steal',
        next: '/evil',
      } as { email: string },
    });

    expect(harness.resetCalls[0]?.options?.redirectTo).toBe(
      'https://www.teerafrik.com/auth/callback',
    );
  });
});

const { updatePasswordFromRecoveryAction } = await import('@/lib/actions/password-reset');

type UpdateHandler = (args: {
  ctx: { supabase: unknown };
  parsedInput: { password: string; confirmPassword: string };
}) => Promise<{ ok: boolean; errorCode?: string }>;
const updatePassword = updatePasswordFromRecoveryAction as unknown as UpdateHandler;

function accessTokenWith(claims: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')}.sig`;
}

function supabaseCtx(options: {
  accessToken: string | null;
  updateError?: { message: string } | null;
  updateCalls?: Array<{ password?: string }>;
}) {
  return {
    supabase: {
      auth: {
        getSession: async () => ({
          data: { session: options.accessToken ? { access_token: options.accessToken } : null },
        }),
        updateUser: async (payload: { password?: string }) => {
          options.updateCalls?.push(payload);
          return { data: {}, error: options.updateError ?? null };
        },
      },
    },
  };
}

const STRONG = 'NouveauMotDePasse2@';

describe('updatePasswordFromRecoveryAction — garde de session de récupération', () => {
  it('accepte une session de récupération et pose le mot de passe', async () => {
    const updateCalls: Array<{ password?: string }> = [];
    const ctx = supabaseCtx({
      accessToken: accessTokenWith({ amr: [{ method: 'recovery' }] }),
      updateCalls,
    });

    const result = await updatePassword({
      ctx,
      parsedInput: { password: STRONG, confirmPassword: STRONG },
    });

    expect(result).toEqual({ ok: true });
    expect(updateCalls).toEqual([{ password: STRONG }]);
  });

  it("REFUSE une session ordinaire : sinon l'action contournerait la ré-authentification de changePasswordAction", async () => {
    const updateCalls: Array<{ password?: string }> = [];
    const ctx = supabaseCtx({
      accessToken: accessTokenWith({ amr: [{ method: 'password' }] }),
      updateCalls,
    });

    const result = await updatePassword({
      ctx,
      parsedInput: { password: STRONG, confirmPassword: STRONG },
    });

    expect(result).toEqual({ ok: false, errorCode: 'invalid_session' });
    expect(updateCalls).toHaveLength(0);
  });

  it('refuse une session absente', async () => {
    const ctx = supabaseCtx({ accessToken: null });

    const result = await updatePassword({
      ctx,
      parsedInput: { password: STRONG, confirmPassword: STRONG },
    });

    expect(result).toEqual({ ok: false, errorCode: 'invalid_session' });
  });

  it('rend une erreur explicite si la mise à jour échoue', async () => {
    const ctx = supabaseCtx({
      accessToken: accessTokenWith({ amr: [{ method: 'recovery' }] }),
      updateError: { message: 'boom' },
    });

    const result = await updatePassword({
      ctx,
      parsedInput: { password: STRONG, confirmPassword: STRONG },
    });

    expect(result).toEqual({ ok: false, errorCode: 'update_failed' });
  });
});

describe('updatePasswordFromRecoveryAction — validation du mot de passe', () => {
  const schema = (
    updatePasswordFromRecoveryAction as unknown as {
      __schema: {
        safeParse: (v: unknown) => {
          success: boolean;
          error?: { issues: Array<{ message: string }> };
        };
      };
    }
  ).__schema;

  it('réutilise le seuil du projet, sans seuil parallèle', () => {
    // Exactement les critères de checkPasswordStrength : 10 caractères, majuscule,
    // minuscule, chiffre, caractère spécial.
    for (const weak of [
      'court1!A',
      'sansmajuscule1!',
      'SANSMINUSCULE1!',
      'SansChiffre!!',
      'SansSpecial123',
    ]) {
      const parsed = schema.safeParse({ password: weak, confirmPassword: weak });
      expect(parsed.success, `attendu refusé : ${weak}`).toBe(false);
    }

    expect(schema.safeParse({ password: STRONG, confirmPassword: STRONG }).success).toBe(true);
  });

  it('exige la confirmation identique', () => {
    const parsed = schema.safeParse({ password: STRONG, confirmPassword: 'AutreMotDePasse3#' });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.some((issue) => issue.message === 'password_mismatch')).toBe(true);
  });
});
