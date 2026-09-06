import {
  assertMaintenanceSupabaseHttpTarget,
  assertPostgresTarget,
  assertSupabaseHttpTarget,
} from '@/lib/security/supabase-target-policy';
import { afterEach, describe, expect, it, vi } from 'vitest';

const createBrowserClient = vi.fn(() => ({ marker: 'client-cree' }));
vi.mock('@supabase/ssr', () => ({ createBrowserClient }));

const originalEnvironment = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnvironment };
  createBrowserClient.mockClear();
});

function serialiseError(error: unknown): string {
  if (!(error instanceof Error)) {
    return JSON.stringify(error);
  }

  return JSON.stringify(error, Object.getOwnPropertyNames(error));
}

describe('politique de cible Supabase', () => {
  it('bloque la fabrique navigateur avant toute creation de client', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://projet-http-sentinelle.example.test';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'cle-synthetique';
    process.env.NEXT_PUBLIC_SUPABASE_ALLOWED_HTTP_ORIGINS = '';
    const { createSupabaseBrowserClient } = await import('@/lib/supabase/client');

    expect(() => createSupabaseBrowserClient()).toThrow(/cible distante interdite/);
    expect(createBrowserClient).not.toHaveBeenCalled();
  });

  it('cree le client navigateur pour une configuration distante autorisee compilee', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://production-synthetique.example.test';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'cle-synthetique';
    process.env.NEXT_PUBLIC_SUPABASE_ALLOWED_HTTP_ORIGINS =
      'https://production-synthetique.example.test';
    const { createSupabaseBrowserClient } = await import('@/lib/supabase/client');

    expect(createSupabaseBrowserClient()).toEqual({ marker: 'client-cree' });
    expect(createBrowserClient).toHaveBeenCalledOnce();
  });

  it('autorise une cible HTTP loopback en developpement', () => {
    expect(() =>
      assertSupabaseHttpTarget({
        target: 'http://127.0.0.1:54321/',
        variableName: 'NEXT_PUBLIC_SUPABASE_URL',
        context: 'server',
      }),
    ).not.toThrow();
  });

  it('refuse une cible HTTP distante en developpement sans divulguer sa valeur', () => {
    const sentinel = 'projet-http-sentinelle.example.test';

    try {
      assertSupabaseHttpTarget({
        target: `https://${sentinel}`,
        variableName: 'NEXT_PUBLIC_SUPABASE_URL',
        context: 'server',
      });
      throw new Error('Le refus etait attendu');
    } catch (error) {
      expect(String(error)).toContain('NEXT_PUBLIC_SUPABASE_URL');
      expect(serialiseError(error)).not.toContain(sentinel);
    }
  });

  it('autorise une cible HTTPS distante cote navigateur quand elle est compilee dans la liste', () => {
    expect(() =>
      assertSupabaseHttpTarget({
        target: 'https://production-synthetique.example.test',
        variableName: 'NEXT_PUBLIC_SUPABASE_URL',
        context: 'browser',
        allowedOrigins: ['https://production-synthetique.example.test'],
      }),
    ).not.toThrow();
  });

  it('ne deverrouille pas une cible HTTP distante avec VERCEL_ENV seul', () => {
    expect(() =>
      assertSupabaseHttpTarget({
        target: 'https://preview-synthetique.example.test',
        variableName: 'NEXT_PUBLIC_SUPABASE_URL',
        context: 'server',
        allowedOrigins: ['https://preview-synthetique.example.test'],
        vercelEnvironment: 'production',
      }),
    ).toThrow(/cible distante interdite/);
  });

  it('autorise une cible HTTP distante avec les marqueurs Vercel et la liste correspondante', () => {
    expect(() =>
      assertSupabaseHttpTarget({
        target: 'https://preview-synthetique.example.test',
        variableName: 'NEXT_PUBLIC_SUPABASE_URL',
        context: 'server',
        allowedOrigins: ['https://preview-synthetique.example.test'],
        vercel: '1',
        vercelEnvironment: 'preview',
      }),
    ).not.toThrow();
  });

  it('refuse les URL HTTP serveur et publique incoherentes', () => {
    expect(() =>
      assertSupabaseHttpTarget({
        target: 'http://127.0.0.1:54321',
        variableName: 'SUPABASE_URL',
        context: 'server',
        serverTarget: 'http://127.0.0.1:54321',
        publicTarget: 'http://127.0.0.1:54322',
      }),
    ).toThrow(/SUPABASE_URL\/NEXT_PUBLIC_SUPABASE_URL/);
  });

  it('refuse une URL PostgreSQL distante sans exposer le mot de passe dans l erreur entiere', () => {
    const sentinel = 'mot-de-passe-pg-sentinelle';
    const input = {
      target: `postgresql://utilisateur:${sentinel}@distant.example.test:5432/base`,
      variableName: 'SUPABASE_DB_URL',
    } as const;

    expect(() => assertPostgresTarget(input)).toThrow(/cible distante interdite/);

    try {
      assertPostgresTarget(input);
    } catch (error) {
      expect(serialiseError(error)).not.toContain(sentinel);
    }
  });

  it('refuse une URL PostgreSQL malformee sans exposer le mot de passe dans l erreur entiere', () => {
    const sentinel = 'mot-de-passe-pg-malforme';
    const input = {
      target: `postgresql://utilisateur:${sentinel}@[invalide`,
      variableName: 'SUPABASE_DB_URL',
    } as const;

    expect(() => assertPostgresTarget(input)).toThrow(/URL invalide/);

    try {
      assertPostgresTarget(input);
    } catch (error) {
      expect(serialiseError(error)).not.toContain(sentinel);
    }
  });

  it('autorise une URL PostgreSQL loopback', () => {
    expect(() =>
      assertPostgresTarget({
        target: 'postgresql://utilisateur:mot-de-passe@localhost:54322/base',
        variableName: 'SUPABASE_DB_URL',
      }),
    ).not.toThrow();
  });

  it('autorise le canal de maintenance seulement pour sa cible explicitement attendue', () => {
    expect(() =>
      assertMaintenanceSupabaseHttpTarget({
        target: 'https://maintenance-synthetique.example.test',
        variableName: 'L2_MAINTENANCE_SUPABASE_URL',
        allowedTarget: 'https://maintenance-synthetique.example.test',
        allowedVariableName: 'L2_MAINTENANCE_SUPABASE_ALLOWED_ORIGIN',
      }),
    ).not.toThrow();
  });

  it('refuse le canal de maintenance sans cible dédiée malgré une valeur ordinaire', () => {
    expect(() =>
      assertMaintenanceSupabaseHttpTarget({
        target: undefined,
        variableName: 'L2_MAINTENANCE_SUPABASE_URL',
        allowedTarget: 'https://maintenance-synthetique.example.test',
        allowedVariableName: 'L2_MAINTENANCE_SUPABASE_ALLOWED_ORIGIN',
      }),
    ).toThrow(/L2_MAINTENANCE_SUPABASE_URL: cible absente/);
  });
});
