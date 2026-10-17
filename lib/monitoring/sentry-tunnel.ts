// Logique pure du tunnel Sentry (voir app/monitoring/route.ts).
export type SentryDsn = { host: string; projectId: string; raw: string };

export function parseSentryDsn(raw: string | undefined): SentryDsn | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const projectId = url.pathname.replace(/^\/+/, '').split('/')[0];
    if (!url.hostname || !/^\d+$/.test(projectId)) return null;
    return { host: url.host, projectId, raw };
  } catch {
    return null;
  }
}

// Un tunnel qui relaie n'importe quelle enveloppe serait un relais ouvert : seule une enveloppe
// dont l'en-tête désigne NOTRE projet est transmise, et la destination se déduit de notre DSN,
// jamais de celui du corps.
export function tunnelTarget(body: string, dsn: SentryDsn): string | null {
  const firstLine = body.slice(0, body.indexOf('\n') === -1 ? body.length : body.indexOf('\n'));
  try {
    const header = JSON.parse(firstLine) as { dsn?: unknown };
    if (typeof header.dsn !== 'string') return null;
    const received = parseSentryDsn(header.dsn);
    if (!received || received.host !== dsn.host || received.projectId !== dsn.projectId) {
      return null;
    }
    return `https://${dsn.host}/api/${dsn.projectId}/envelope/`;
  } catch {
    return null;
  }
}
