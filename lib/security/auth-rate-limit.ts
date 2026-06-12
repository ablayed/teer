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

let warnedMissingInProd = false;

export async function checkAuthRateLimit(
  name: AuthRateLimitName,
  key: string,
): Promise<{ ok: boolean }> {
  if (!limiters) {
    // Non configuré → fail-open. En prod uniquement, on signale une fois (mauvaise config).
    if (process.env.NODE_ENV === 'production' && !warnedMissingInProd) {
      warnedMissingInProd = true;
      Sentry.captureMessage('Auth rate-limit non configuré (UPSTASH_REDIS_REST_* absents)', {
        level: 'warning',
        tags: { component: 'auth-rate-limit' },
      });
    }
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
