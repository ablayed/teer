// V11 — installation réelle de l'instrumentation des appels Supabase (runtime nodejs seulement).
//
// Importé dynamiquement par `instrumentation.ts`, derrière `NEXT_RUNTIME === 'nodejs'` ET le
// drapeau `V11_SUPABASE_TRACE=1` : sans le drapeau, ce module n'est jamais chargé. Les variables
// sont lues directement (comme `IDLE_TIMEOUT_MS` du layout) et non par `lib/env` : ce drapeau est
// TEMPORAIRE, et une erreur de configuration ici ne doit jamais empêcher le démarrage.
import { randomUUID } from 'node:crypto';
import { subscribe } from 'node:diagnostics_channel';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { installSupabaseCallTrace } from './supabase-call-trace';

const INSTALLED = Symbol.for('teer.v11.supabaseCallTrace');

export function installSupabaseCallTraceFromEnvironment(): void {
  const registry = globalThis as unknown as Record<symbol, boolean>;
  if (registry[INSTALLED]) return; // rechargement à chaud en développement : un seul abonnement
  registry[INSTALLED] = true;

  let host: string;
  try {
    host = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').host;
  } catch {
    return; // pas d'URL Supabase exploitable : rien à mesurer
  }
  if (host === '') return;

  // Retard de la boucle d'événements : fenêtres d'une seconde. Le plancher de lecture est la
  // résolution de l'échantillonneur (10 ms) : une boucle libre affiche ~10 ms, pas 0.
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  let lastWindow: { p99: number; max: number } | null = null;
  const timer = setInterval(() => {
    const p99 = histogram.percentile(99) / 1e6;
    const max = histogram.max / 1e6;
    lastWindow = Number.isFinite(p99) && Number.isFinite(max) ? { p99, max } : null;
    histogram.reset();
  }, 1000);
  timer.unref();

  installSupabaseCallTrace({
    subscribe: (channel, handler) => subscribe(channel, handler),
    now: () => performance.now(),
    emit: (line) => console.log(line),
    supabaseHost: host,
    bootId: randomUUID(),
    boot: {
      node: process.version,
      undici: process.versions.undici ?? null,
      region: process.env.VERCEL_REGION ?? null,
      vercel_env: process.env.VERCEL_ENV ?? null,
      loop_resolution_ms: 10,
    },
    loopLag: () => lastWindow,
  });
}
