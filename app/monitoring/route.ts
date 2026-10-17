import { parseSentryDsn, tunnelTarget } from '@/lib/monitoring/sentry-tunnel';

// Tunnel Sentry du client. Remplace la réécriture `tunnelRoute` du SDK : une réécriture de la
// plateforme transmet à Sentry l'adresse IP du visiteur (en-tête de transfert), qui en déduit alors
// une géolocalisation. Ici le corps seul est relayé, sans aucun en-tête de la requête entrante ;
// Sentry ne voit que l'adresse du serveur.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 1_000_000;

export async function POST(request: Request) {
  const dsn = parseSentryDsn(process.env.NEXT_PUBLIC_SENTRY_DSN);
  if (!dsn) return new Response(null, { status: 404 });

  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) return new Response(null, { status: 413 });
  const body = await request.text();
  if (body.length > MAX_BODY_BYTES) return new Response(null, { status: 413 });

  const target = tunnelTarget(body, dsn);
  if (!target) return new Response(null, { status: 400 });

  try {
    const upstream = await fetch(target, {
      method: 'POST',
      body,
      headers: { 'content-type': 'application/x-sentry-envelope' },
      signal: AbortSignal.timeout(10_000),
    });
    return new Response(null, { status: upstream.status });
  } catch {
    return new Response(null, { status: 502 });
  }
}
