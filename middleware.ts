import { buildCspHeader, cspRegimeForPath } from '@/lib/security/csp';
import { type NextRequest, NextResponse } from 'next/server';

// Middleware UNIQUEMENT EN-TÊTES (Content-Security-Policy + nonce). Volontairement
// sans aucune logique d'auth ni import Supabase : l'auth et le mur de consentement
// vivent dans les layouts Server Component (`app/(app)/layout.tsx`). Un précédent
// middleware d'auth avait été retiré (commit 76ca482) à cause de la résolution de
// modules edge Vercel avec l'import Supabase ; ce middleware-ci n'a aucune de ces
// dépendances → edge-safe.
//
// CSP à deux régimes (voir lib/security/csp.ts pour la justification complète) :
//   • pages publiques STATIQUES (landing, légales, /connexion) : script-src
//     'self' 'unsafe-inline' (surface XSS quasi-nulle ; cache statique + Lighthouse
//     préservés ; le nonce est impossible sur une page prérendue).
//   • tout le reste (app authentifiée, onboarding, réacceptation, invitation) :
//     nonce + 'strict-dynamic', SANS 'unsafe-inline' — posture maximale là où vivent
//     l'auth et les données tenant.
export function middleware(request: NextRequest) {
  const isDev = process.env.NODE_ENV === 'development';
  const regime = cspRegimeForPath(request.nextUrl.pathname);
  const requestHeaders = new Headers(request.headers);
  const workspaceMatch = request.nextUrl.pathname.match(/^\/s\/([^/]+)(\/.*)?$/);
  if (workspaceMatch) {
    requestHeaders.set('x-teer-workspace-entry', '0');
    requestHeaders.set('x-teer-store-id', workspaceMatch[1]);
  } else if (request.nextUrl.pathname === '/s') {
    requestHeaders.delete('x-teer-store-id');
    requestHeaders.set('x-teer-workspace-entry', '1');
  } else {
    requestHeaders.delete('x-teer-store-id');
    requestHeaders.delete('x-teer-workspace-entry');
  }

  let rewriteUrl: URL | null = null;
  if (workspaceMatch) {
    rewriteUrl = request.nextUrl.clone();
    rewriteUrl.pathname = workspaceMatch[2] || '/tableau';
  }

  // Régime statique : en-tête déterministe, pas de nonce → la réponse reste
  // cacheable (le corps prérendu n'est pas réécrit).
  if (regime === 'static') {
    const response = rewriteUrl
      ? NextResponse.rewrite(rewriteUrl, { request: { headers: requestHeaders } })
      : NextResponse.next({ request: { headers: requestHeaders } });
    response.headers.set('Content-Security-Policy', buildCspHeader({ regime, isDev }));
    return response;
  }

  // Régime app : nonce par-requête. Next lit le nonce depuis l'en-tête CSP de la
  // REQUÊTE et l'applique automatiquement à ses propres scripts (framework + flight).
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const csp = buildCspHeader({ regime, isDev, nonce });

  // Défense en profondeur CVE-2025-29927 : on neutralise l'en-tête interne
  // potentiellement usurpé par un client. (La vraie protection reste la version
  // Next 15.5.x ≥ 15.2.3, et il n'y a de toute façon plus de middleware d'auth à
  // contourner ici.)
  requestHeaders.delete('x-middleware-subrequest');
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  const response = rewriteUrl
    ? NextResponse.rewrite(rewriteUrl, { request: { headers: requestHeaders } })
    : NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  // On exclut les assets statiques, les routes API (JSON/webhooks HMAC, hors régime
  // CSP HTML) et le tunnel Sentry /monitoring. Les en-têtes communs (HSTS, nosniff,
  // X-Frame-Options, Referrer-Policy, Permissions-Policy) sont posés globalement via
  // next.config.mjs `headers()` (donc aussi sur /api et les assets).
  matcher: [
    '/((?!api|monitoring|_next/static|_next/image|favicon.ico|manifest.webmanifest|sw.js|robots.txt|sitemap.xml|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico|js|css|woff2?|ttf)$).*)',
  ],
};
