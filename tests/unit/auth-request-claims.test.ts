import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ getClaims: vi.fn(), getUser: vi.fn() }));
vi.mock('@/lib/env', () => ({
  publicEnv: {
    NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: '',
  },
}));
vi.mock('@/lib/supabase/protected-client', () => ({
  assertProtectedSupabaseServerTarget: vi.fn(),
}));
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({ auth: { getClaims: h.getClaims, getUser: h.getUser } }),
}));
vi.mock('next/headers', () => ({ cookies: async () => ({ getAll: () => [], set: vi.fn() }) }));
const { getRequestClaims } = await import('@/lib/supabase/server');

beforeEach(() => vi.clearAllMocks());
describe('Identité de rendu issue de claims vérifiés', () => {
  it('ne renvoie que sub et email, jamais les métadonnées utilisateur', async () => {
    h.getClaims.mockResolvedValue({
      data: {
        claims: { sub: 'user-a', email: 'a@example.com', user_metadata: { name: 'ignored' } },
      },
      error: null,
    });
    expect(await getRequestClaims()).toEqual({ userId: 'user-a', email: 'a@example.com' });
    expect(h.getUser).not.toHaveBeenCalled();
  });
  it('refuse une erreur de validation même si des claims sont présents', async () => {
    h.getClaims.mockResolvedValue({
      data: { claims: { sub: 'user-a' } },
      error: { code: 'invalid_jwt' },
    });
    expect(await getRequestClaims()).toBeNull();
  });
  it.each([null, {}, { sub: '' }, { sub: 42 }])(
    'refuse une identité absente ou mal formée : %j',
    async (claims) => {
      h.getClaims.mockResolvedValue({ data: { claims }, error: null });
      expect(await getRequestClaims()).toBeNull();
    },
  );
  it('accepte un JWT vérifié sans email', async () => {
    h.getClaims.mockResolvedValue({ data: { claims: { sub: 'user-b' } }, error: null });
    expect(await getRequestClaims()).toEqual({ userId: 'user-b', email: null });
  });
});
