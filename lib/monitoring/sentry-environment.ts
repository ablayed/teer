// Nom d'environnement Sentry unique pour le client, Node et Edge.
//
// Sans réglage explicite, le SDK serveur rapporte `vercel-production` (il lit VERCEL_ENV) et le
// SDK client `production` (il lit NODE_ENV) : un même déploiement apparaissait sous deux noms, et
// un aperçu client sous `production`. Module pur, sans dépendance, importable depuis l'Edge.
const VERCEL_ENVIRONMENTS = new Set(['production', 'preview', 'development']);

export function resolveSentryEnvironment(
  explicit: string | undefined,
  vercelEnvironment: string | undefined,
): string {
  const named = explicit?.trim();
  if (named) return named;
  const vercel = vercelEnvironment?.trim();
  return vercel && VERCEL_ENVIRONMENTS.has(vercel) ? vercel : 'development';
}
