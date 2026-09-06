type TargetClass = 'loopback' | 'distant';

type ParsedTarget = Readonly<{
  protocol: string;
  hostname: string;
  port: string;
  targetClass: TargetClass;
}>;

type HttpContext = 'browser' | 'server' | 'test';

export type SupabaseHttpTargetInput = Readonly<{
  target: string | undefined;
  variableName: 'SUPABASE_URL' | 'NEXT_PUBLIC_SUPABASE_URL';
  context: HttpContext;
  serverTarget?: string | undefined;
  publicTarget?: string | undefined;
  allowedOrigins?: readonly string[] | undefined;
  vercel?: string | undefined;
  vercelEnvironment?: string | undefined;
}>;

export type PostgresTargetInput = Readonly<{
  target: string | undefined;
  variableName: string;
}>;

export type MaintenanceSupabaseHttpTargetInput = Readonly<{
  target: string | undefined;
  variableName: string;
  allowedTarget: string | undefined;
  allowedVariableName: string;
}>;

function refusal(message: string): never {
  throw new Error(message);
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/** Classifie un hote normalise sans conserver l'URL ni ses identifiants. */
export function classifySupabaseHost(hostname: string): TargetClass {
  return isLoopbackHostname(hostname.toLowerCase().replace(/\.$/, '')) ? 'loopback' : 'distant';
}

function parseTarget(
  target: string | undefined,
  variableName: string,
  protocols: readonly string[],
  allowUserinfo = false,
): ParsedTarget {
  if (!target?.trim()) {
    return refusal(`${variableName}: cible absente`);
  }

  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return refusal(`${variableName}: URL invalide`);
  }

  if (
    !protocols.includes(parsed.protocol) ||
    (!allowUserinfo && (parsed.username || parsed.password))
  ) {
    return refusal(`${variableName}: URL invalide`);
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  const port =
    parsed.port || (parsed.protocol === 'https:' ? '443' : parsed.protocol === 'http:' ? '80' : '');
  return { protocol: parsed.protocol, hostname, port, targetClass: classifySupabaseHost(hostname) };
}

function sameTarget(left: ParsedTarget, right: ParsedTarget): boolean {
  return (
    left.protocol === right.protocol && left.hostname === right.hostname && left.port === right.port
  );
}

function parseAllowedOrigins(origins: readonly string[] | undefined): ParsedTarget[] {
  return (origins ?? []).map((origin) =>
    parseTarget(origin, 'SUPABASE_ALLOWED_HTTP_ORIGINS', ['https:']),
  );
}

/**
 * Controle une cible HTTP Supabase avant la creation d'un client.
 * Les marqueurs Vercel prouvent seulement que la configuration complete a ete injectee;
 * ils n'authentifient pas le processus qui les presente.
 */
export function assertSupabaseHttpTarget(input: SupabaseHttpTargetInput): void {
  const target = parseTarget(input.target, input.variableName, ['http:', 'https:']);

  if (input.serverTarget && input.publicTarget) {
    const server = parseTarget(input.serverTarget, 'SUPABASE_URL', ['http:', 'https:']);
    const publicTarget = parseTarget(input.publicTarget, 'NEXT_PUBLIC_SUPABASE_URL', [
      'http:',
      'https:',
    ]);
    if (!sameTarget(server, publicTarget)) {
      refusal('SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL: cibles incoherentes');
    }
  }

  if (target.targetClass === 'loopback') {
    return;
  }

  const allowed = parseAllowedOrigins(input.allowedOrigins);
  const isAllowed = allowed.some((allowedTarget) => sameTarget(target, allowedTarget));

  if (input.context === 'browser') {
    if (target.protocol === 'https:' && isAllowed) {
      return;
    }
    refusal(`${input.variableName}: cible distante interdite`);
  }

  const isVercelEnvironment =
    input.vercel === '1' &&
    (input.vercelEnvironment === 'preview' || input.vercelEnvironment === 'production');
  if (target.protocol === 'https:' && isVercelEnvironment && isAllowed) {
    return;
  }

  refusal(`${input.variableName}: cible distante interdite`);
}

/** Controle un canal de maintenance explicite, distinct des fabriques applicatives. */
export function assertMaintenanceSupabaseHttpTarget(
  input: MaintenanceSupabaseHttpTargetInput,
): void {
  const target = parseTarget(input.target, input.variableName, ['https:']);
  const allowed = parseTarget(input.allowedTarget, input.allowedVariableName, ['https:']);
  if (!sameTarget(target, allowed)) {
    refusal(`${input.variableName}: cible distante interdite`);
  }
}

/** Controle une cible PostgreSQL ordinaire avant toute construction de client. */
export function assertPostgresTarget(input: PostgresTargetInput): void {
  const target = parseTarget(input.target, input.variableName, ['postgres:', 'postgresql:'], true);
  if (target.targetClass !== 'loopback') {
    refusal(`${input.variableName}: cible distante interdite`);
  }
}

/** Convertit une liste d'origines compilee ou injectee en entrees explicites. */
export function splitSupabaseAllowedOrigins(value: string | undefined): string[] {
  return (
    value
      ?.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean) ?? []
  );
}
