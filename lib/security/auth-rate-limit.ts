import { env } from '@/lib/env';
import * as Sentry from '@sentry/nextjs';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

// Rate-limiting PAR IP des actions d'authentification (login / signup), sur Upstash
// Redis en fenêtre glissante. DISTINCT de lib/ia/rate-limit.ts (compteur métier
// Postgres par-tenant pour l'assistant) — logique et clé différentes ; ne pas mélanger.
//
// Fail-open (cf. règle 5 du brief) : si Upstash n'est pas configuré (CI/local) ou
// injoignable, on LAISSE PASSER — un Redis down/absent ne doit jamais verrouiller un
// marchand légitime dehors, ni casser le build. En prod (Vercel a les env vars) le
// limiter est actif ; si jamais il manquait en prod, on émet une alerte Sentry (une
// fois) pour rendre la mauvaise config visible sans bloquer.

const url = env.UPSTASH_REDIS_REST_URL;
const token = env.UPSTASH_REDIS_REST_TOKEN;

const redis = url && token ? new Redis({ url, token }) : null;

const limiters = redis
  ? {
      // 5 tentatives / 60 s / IP.
      login: new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(5, '60 s'),
        prefix: 'rl:auth:login',
        analytics: false,
      }),
      // 3 inscriptions / heure / IP.
      signup: new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(3, '1 h'),
        prefix: 'rl:auth:signup',
        analytics: false,
      }),
    }
  : null;

export type AuthRateLimitName = 'login' | 'signup';

// Garde-fou de démarrage : appelé une fois au boot (instrumentation.ts register()).
// Si on tourne en PROD Vercel (VERCEL_ENV === 'production') sans les env Upstash, on
// crie dans Sentry — sinon le fail-open laisserait /login sans aucune protection EN
// SILENCE. On garde les env optionnelles (dev/preview/CI libres) ; seule la vraie prod
// alerte. `VERCEL_ENV` est une variable système Vercel (jamais en NEXT_PUBLIC_).
export function reportAuthRateLimitConfigAtBoot(): void {
  if (process.env.VERCEL_ENV !== 'production') {
    return;
  }
  if (url && token) {
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
  if (!limiters) {
    // Non configuré → fail-open (l'alerte prod est émise au boot, cf. ci-dessus).
    return { ok: true };
  }

  try {
    const { success } = await limiters[name].limit(key);
    return { ok: success };
  } catch (error) {
    // Redis injoignable → fail-open (ne pas verrouiller les marchands).
    Sentry.captureException(error, { tags: { component: 'auth-rate-limit', limiter: name } });
    return { ok: true };
  }
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
