import * as Sentry from '@sentry/nextjs';

// Le SDK installe un fournisseur OpenTelemetry global : un scénario par fichier de test (isolé par Vitest).
export async function typesEnveloppes(options: Record<string, unknown>, sampledParent: boolean) {
  const types: string[] = [];
  Sentry.init({
    dsn: 'https://cle@exemple.invalid/1',
    defaultIntegrations: false,
    transport: () => ({
      send: async (envelope: [unknown, [{ type: string }, unknown][]]) => {
        for (const item of envelope[1]) types.push(item[0].type);
        return {};
      },
      flush: async () => true,
    }),
    ...options,
  });
  Sentry.continueTrace(
    {
      sentryTrace: `${'a'.repeat(32)}-${'b'.repeat(16)}-${sampledParent ? '1' : '0'}`,
      baggage: undefined,
    },
    () => {
      Sentry.startSpan({ name: 'GET /exemple', op: 'http.server' }, () => {});
    },
  );
  Sentry.captureException(new TypeError('erreur de contrôle'));
  await Sentry.flush(2000);
  await Sentry.close();
  return types;
}
