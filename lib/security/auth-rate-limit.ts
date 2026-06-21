import { checkRateLimit, isRateLimitBackendConfigured } from '@/lib/security/rate-limit';
import * as Sentry from '@sentry/nextjs';

// Rate-limiting PAR IP des actions d'authentification (login / signup), sur Upstash
// Redis en fenêtre glissante. DISTINCT de lib/ia/rate-limit.ts (compteur métier
// Postgres par-tenant pour l'assistant) — logique et clé différentes ; ne pas mélanger.
//
// Fail-open (cf. règle 5 du brief) : si Upstash n'est pas configuré (CI/local) ou
// injoignable, on LAISSE PASSER — un Redis down/absent ne doit jamais verrouiller un
// marchand légitime dehors, ni casser le build. En prod (Vercel a les env vars) le
// limiter est actif ; si jamais il manquait en prod, on émet une alerte Sentry (une
// fois) pour rendre la mauvaise config visible sans bloquer.

export type AuthRateLimitName = 'login' | 'signup';

const authPolicyByName = {
  login: 'auth_login',
  signup: 'auth_signup',
} as const;

// Garde-fou de démarrage : appelé une fois au boot (instrumentation.ts register()).
// Si on tourne en PROD Vercel (VERCEL_ENV === 'production') sans les env Upstash, on
// crie dans Sentry — sinon le fail-open laisserait /login sans aucune protection EN
// SILENCE. On garde les env optionnelles (dev/preview/CI libres) ; seule la vraie prod
// alerte. `VERCEL_ENV` est une variable système Vercel (jamais en NEXT_PUBLIC_).
export function reportAuthRateLimitConfigAtBoot(): void {
  if (process.env.VERCEL_ENV !== 'production') {
    return;
  }
  if (isRateLimitBackendConfigured()) {
    return; // correctement configuré
  }
  Sentry.captureMessage(
    'Auth rate-limit NON configuré en PROD (UPSTASH_REDIS_REST_* absents) → /login en fail-open',
    { level: 'warning', tags: { component: 'auth-rate-limit', phase: 'boot' } },
  );
}

export async function checkAuthRateLimit(
  name: AuthRateLimitName,
  key: string,
): Promise<{ ok: boolean }> {
  return checkRateLimit(authPolicyByName[name], key);
}

// Clé de rate-limit = IP de l'appelant. `x-forwarded-for` (1er hop) puis fallback
// `x-real-ip` ; rien → 'unknown' (repli : les requêtes sans IP partagent un bucket).
// On n'utilise JAMAIS l'email comme clé (pas de fuite/énumération).
export function getClientIp(headers: Headers): string {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) {
      return first;
    }
  }
  return headers.get('x-real-ip')?.trim() || 'unknown';
}
