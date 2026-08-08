// Construction des en-têtes Content-Security-Policy pour les deux régimes du site.
// Module PUR et EDGE-SAFE : il ne lit que des variables NEXT_PUBLIC_* (inlinées au
// build, disponibles au edge) et n'importe PAS `lib/env` (qui validerait des secrets
// serveur absents du runtime edge). Consommé par `middleware.ts`.
//
// DEUX RÉGIMES (décision Phase 9, validée) :
//
//   • Régime « app » (routes rendues dynamiquement) → nonce + 'strict-dynamic',
//     SANS 'unsafe-inline' sur script-src. C'est là que vivent l'auth, les données
//     tenant et le moteur COD : posture maximale.
//
//   • Régime « static » (pages publiques PRÉRENDUES : landing, pages légales,
//     /connexion) → script-src 'self' 'unsafe-inline'.
//     Pourquoi pas de hash/nonce ici : une page statique ne peut pas porter de nonce
//     par-requête, et Next App Router émet TOUJOURS ~33 scripts inline (flight RSC
//     `self.__next_f.push`). Testé en Phase 9 : `experimental.sri` ne signe que les
//     scripts EXTERNES (les inline restent inchangés) → 'self' seul les bloquerait.
//     Un pipeline de hash custom n'est pas livrable proprement (les hash ne sont
//     connus qu'APRÈS `next build`, alors que le middleware edge est bundlé PENDANT).
//     On accepte donc 'unsafe-inline' UNIQUEMENT sur ces pages : surface XSS
//     quasi-nulle (aucun input attaquant rendu, seulement des traductions serveur +
//     un JSON-LD de confiance), zéro auth/session/secret. Le 'unsafe-inline' ne
//     touche JAMAIS l'app authentifiée. Cache statique + Lighthouse préservés.

export type CspRegime = 'app' | 'embedded' | 'static';

// Pages publiques statiquement prérendues (○ au build). Tout le reste relève du
// régime « app » strict (défaut sécuritaire : une nouvelle route authentifiée hérite
// du nonce ; une page statique non listée verrait ses scripts inline bloqués, ce qui
// se voit immédiatement en dev/E2E).
const STATIC_PUBLIC_PATHS = new Set<string>([
  '/',
  '/connexion',
  '/confidentialite',
  '/conditions',
  '/dpa',
  '/mentions-legales',
]);

export function cspRegimeForPath(pathname: string): CspRegime {
  if (pathname === '/shopify/embedded' || pathname.startsWith('/shopify/embedded/')) {
    return 'embedded';
  }

  return STATIC_PUBLIC_PATHS.has(pathname) ? 'static' : 'app';
}

// Hôtes PostHog pour connect-src (régime app uniquement) : posthog-js est bundlé
// (script couvert par 'self'/'strict-dynamic') mais ingère ses events et charge sa
// config distante en XHR. On autorise l'hôte d'ingestion ET son hôte d'assets
// (préfixe « -assets » sur le 1er label, ex. us.i.posthog.com → us-assets.i.posthog.com).
function posthogConnectHosts(): string[] {
  const raw = process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com';
  try {
    const url = new URL(raw);
    const hosts = new Set<string>([url.origin]);
    const [first, ...rest] = url.hostname.split('.');
    if (first && rest.length > 0) {
      hosts.add(`${url.protocol}//${first}-assets.${rest.join('.')}`);
    }
    return [...hosts];
  } catch {
    return [];
  }
}

type BuildCspOptions = {
  regime: CspRegime;
  isDev: boolean;
  /** Nonce par-requête (régime « app » uniquement). */
  nonce?: string;
};

export function buildCspHeader({ regime, isDev, nonce }: BuildCspOptions): string {
  const scriptSrc =
    regime === 'static'
      ? // Pages publiques statiques : voir l'en-tête de module pour la justification.
        ["'self'", "'unsafe-inline'", isDev ? "'unsafe-eval'" : ''].filter(Boolean)
      : // App dynamique : durci. 'strict-dynamic' fait ignorer 'self'/https: par les
        // navigateurs récents (qui ne se fient qu'au nonce + scripts propagés) ;
        // 'self' https: restent en repli pour les navigateurs sans strict-dynamic.
        [
          "'self'",
          nonce ? `'nonce-${nonce}'` : '',
          "'strict-dynamic'",
          'https:',
          isDev ? "'unsafe-eval'" : '', // React Refresh en dev
        ].filter(Boolean);

  const connectSrc =
    regime === 'static'
      ? ["'self'"]
      : // App : ingestion analytics (Sentry passe par le tunnel same-origin /monitoring).
        ["'self'", ...posthogConnectHosts(), isDev ? 'ws:' : ''].filter(Boolean);

  const frameAncestors =
    regime === 'embedded' ? 'https://admin.shopify.com https://*.myshopify.com' : "'none'";

  const directives: Array<[string, string]> = [
    ['default-src', "'self'"],
    ['script-src', scriptSrc.join(' ')],
    // 'unsafe-inline' sur style-src : attributs style inline (animations CSS de la
    // landing, styles injectés par React) non noncables — compromis standard, faible
    // risque. On durcit script-src, pas style-src.
    ['style-src', "'self' 'unsafe-inline'"],
    ['img-src', "'self' data: https:"],
    ['font-src', "'self'"], // Geist + Fraunces auto-hébergés via next/font
    ['connect-src', connectSrc.join(' ')],
    ['frame-ancestors', frameAncestors],
    ['base-uri', "'self'"],
    ['form-action', "'self'"],
    ['object-src', "'none'"],
  ];

  // `upgrade-insecure-requests` UNIQUEMENT en prod (https). En local/CI http, WebKit
  // (iPhone) applique l'upgrade jusqu'à `http://localhost` → bascule en https
  // inexistant → page blanche → tous les sélecteurs E2E expirent (Chromium, lui,
  // exempte le loopback). En prod c'est redondant avec HSTS preload (same-origin déjà
  // https) ; on le garde par défense en profondeur côté serveur https.
  //
  // Retiré AUSSI en build de test E2E (`NEXT_PUBLIC_DISABLE_UIR='1'`) : un build de
  // prod servi sur `http://localhost` (next start) émettrait sinon l'UIR et blanchirait
  // WebKit. Le flag est un `NEXT_PUBLIC_*` inliné au `next build` → conforme à la
  // doctrine edge-safe de ce module (jamais de secret/`lib/env`). En prod réelle, le
  // flag est absent → l'UIR reste émis à l'identique.
  const disableUir = process.env.NEXT_PUBLIC_DISABLE_UIR === '1';
  if (!isDev && !disableUir) {
    directives.push(['upgrade-insecure-requests', '']);
  }

  return directives.map(([name, value]) => (value ? `${name} ${value}` : name)).join('; ');
}
