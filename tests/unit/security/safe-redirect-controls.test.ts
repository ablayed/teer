import { safeRedirectPath } from '@/lib/security/safe-redirect';
import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({ createSupabaseServerClient: vi.fn() }));
import { GET } from '@/app/auth/callback/route';

describe('SEC-C-003 internal redirect contract', () => {
  it.each([
    '/tableau',
    '/s/123/commandes?q=appel%20demain',
    '/produits#stock',
    '/s?next=%2Ffinances',
  ])('keeps ordinary internal destination %s', (path) => {
    expect(safeRedirectPath(path)).toBe(path);
  });
  it.each([undefined, '', 'https://example.invalid/', '//example.invalid/', '/\\example.invalid/'])(
    'retains existing rejection of unsafe destinations',
    (path) => {
      expect(safeRedirectPath(path)).toBe('/tableau');
    },
  );
  it('rejects every ASCII control and DEL without URL normalization changing the origin', () => {
    for (const value of [...Array.from({ length: 32 }, (_, index) => index), 127]) {
      const path = `/${String.fromCharCode(value)}/example.invalid/`;
      expect(safeRedirectPath(path)).toBe('/tableau');
    }
  });
  it.each(['\t', '\n', '\r'])(
    'callback returns the internal fallback for control %j',
    async (control) => {
      const url = new URL('https://teer.example.test/auth/callback');
      url.searchParams.set('redirectTo', `/${control}/example.invalid/`);
      const response = await GET(new NextRequest(url));
      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toBe('https://teer.example.test/tableau');
    },
  );
  it('callback preserves the legitimate internal query and anchor', async () => {
    const url = new URL('https://teer.example.test/auth/callback');
    url.searchParams.set('redirectTo', '/commandes?q=appel%20demain#liste');
    const response = await GET(new NextRequest(url));
    expect(response.headers.get('location')).toBe(
      'https://teer.example.test/commandes?q=appel%20demain#liste',
    );
  });
});
