import { afterEach, describe, expect, it, vi } from 'vitest';

const createClient = vi.fn(() => ({ marker: 'admin-cree' }));
const createServerClient = vi.fn(() => ({ marker: 'serveur-cree' }));
const cookies = vi.fn(async () => ({ getAll: () => [], set: vi.fn() }));
const publicEnv = {
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'cle-anonyme-synthetique',
};

vi.mock('@supabase/supabase-js', () => ({ createClient }));
vi.mock('@supabase/ssr', () => ({ createServerClient }));
vi.mock('next/headers', () => ({ cookies }));
vi.mock('@/lib/env', () => ({ publicEnv }));

const originalEnvironment = { ...process.env };

function configureLoopback(): void {
  process.env.SUPABASE_URL = 'http://127.0.0.1:54321';
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
  process.env.SUPABASE_ALLOWED_HTTP_ORIGINS = undefined;
  process.env.VERCEL = undefined;
  process.env.VERCEL_ENV = undefined;
  publicEnv.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:54321';
}

afterEach(() => {
  process.env = { ...originalEnvironment };
  configureLoopback();
  createClient.mockClear();
  createServerClient.mockClear();
  cookies.mockClear();
});

describe('fabriques Supabase protegees', () => {
  it('refuse la fabrique admin avant le constructeur puis autorise loopback', async () => {
    const { createProtectedSupabaseClient } = await import('@/lib/supabase/protected-client');
    process.env.SUPABASE_URL = 'https://admin-interdite.example.test';
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://admin-interdite.example.test';

    expect(() =>
      createProtectedSupabaseClient('https://admin-interdite.example.test', 'cle-synthetique'),
    ).toThrow(/cible distante interdite/);
    expect(createClient).not.toHaveBeenCalled();

    configureLoopback();
    expect(createProtectedSupabaseClient('http://127.0.0.1:54321', 'cle-synthetique')).toEqual({
      marker: 'admin-cree',
    });
    expect(createClient).toHaveBeenCalledOnce();
  });

  it('refuse la fabrique serveur avant le constructeur puis autorise loopback', async () => {
    const { createSupabaseServerClient } = await import('@/lib/supabase/server');
    publicEnv.NEXT_PUBLIC_SUPABASE_URL = 'https://serveur-interdit.example.test';
    process.env.SUPABASE_URL = 'https://serveur-interdit.example.test';
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://serveur-interdit.example.test';

    await expect(createSupabaseServerClient()).rejects.toThrow(/cible distante interdite/);
    expect(createServerClient).not.toHaveBeenCalled();
    expect(cookies).not.toHaveBeenCalled();

    configureLoopback();
    await expect(createSupabaseServerClient()).resolves.toEqual({ marker: 'serveur-cree' });
    expect(createServerClient).toHaveBeenCalledOnce();
  });
});
