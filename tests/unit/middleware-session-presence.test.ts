import { middleware } from '@/middleware';
import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';

describe('Redirection immédiate sans cookie de session', () => {
  it.each(['/commandes', '/s/shop-a/commandes', '/tableau', '/livreurs'])(
    'redirige %s sans cookie en HTTP 307',
    (route) => {
      const response = middleware(new NextRequest(`http://localhost:3000${route}`));
      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toBe('http://localhost:3000/connexion');
    },
  );
  it.each(['sb-local-auth-token', 'sb-local-auth-token.0'])(
    'laisse la validation d’un cookie présent %s au serveur',
    (name) => {
      const request = new NextRequest('http://localhost:3000/commandes', {
        headers: { cookie: `${name}=invalid` },
      });
      const response = middleware(request);
      expect(response.status).toBe(200);
      expect(response.headers.get('location')).toBeNull();
      expect(response.headers.get('content-security-policy')).toContain("'strict-dynamic'");
    },
  );
  it('un vérificateur PKCE seul ne vaut pas présence du cookie de session', () => {
    const request = new NextRequest('http://localhost:3000/commandes', {
      headers: { cookie: 'sb-local-auth-token-code-verifier=invalid' },
    });
    expect(middleware(request).status).toBe(307);
  });
  it.each(['/connexion', '/conditions', '/mot-de-passe-oublie'])(
    'ne redirige pas la page publique %s',
    (route) => {
      expect(
        middleware(new NextRequest(`http://localhost:3000${route}`)).headers.get('location'),
      ).toBeNull();
    },
  );
});
