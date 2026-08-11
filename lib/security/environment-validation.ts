export type EnvironmentVariables = Readonly<Record<string, string | undefined>>;

const PLACEHOLDER_VALUE_PATTERN =
  /^(?:change[-_ ]?me|dummy|example|placeholder|secret|test)(?:[-_ ].*)?$/i;

const SHOPIFY_APP_SECRET_PAIRS = [
  ['SHOPIFY_API_KEY', 'SHOPIFY_API_SECRET'],
  ['SHOPIFY_PILOTE_API_KEY', 'SHOPIFY_PILOTE_API_SECRET'],
  ['SHOPIFY_MARCHAND_API_KEY', 'SHOPIFY_MARCHAND_API_SECRET'],
  ['SHOPIFY_KOBA_API_KEY', 'SHOPIFY_KOBA_API_SECRET'],
] as const;

function isPresent(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPlaceholder(value: string | undefined): boolean {
  return isPresent(value) && PLACEHOLDER_VALUE_PATTERN.test(value.trim());
}

function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '[::1]' ||
    normalized.endsWith('.local') ||
    normalized.endsWith('.test') ||
    normalized.endsWith('.invalid')
  );
}

function isSecurePublicUrl(value: string | undefined): boolean {
  if (!isPresent(value)) {
    return false;
  }

  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === 'https:' &&
      !isLocalHostname(parsed.hostname) &&
      !parsed.username &&
      !parsed.password
    );
  } catch {
    return false;
  }
}

function isAes256GcmKey(value: string | undefined): boolean {
  return isPresent(value) && /^[0-9a-f]{64}$/i.test(value);
}

/**
 * A public Sentry DSN is `https://<publicKey>@<host>/<projectId>` — the public key is
 * carried in the URL's userinfo/username slot by design, unlike a plain app URL.
 * `isSecurePublicUrl` rejects any username component, so it cannot validate this shape;
 * this validator allows a username but still rejects a password (a real secret) and any
 * insecure/local/malformed URL.
 */
function isValidSentryDsn(value: string | undefined): boolean {
  if (!isPresent(value)) {
    return false;
  }

  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && !isLocalHostname(parsed.hostname) && !parsed.password;
  } catch {
    return false;
  }
}

function addRequiredSecretIssue(
  issues: string[],
  values: EnvironmentVariables,
  name: string,
): void {
  const value = values[name];
  if (!isPresent(value)) {
    issues.push(`${name}:missing`);
    return;
  }

  if (isPlaceholder(value)) {
    issues.push(`${name}:placeholder`);
  }
}

export function isProductionEnvironment(values: EnvironmentVariables): boolean {
  if (values.VERCEL_ENV) {
    return values.VERCEL_ENV === 'production';
  }

  return values.NODE_ENV === 'production';
}

/** Rejects only configurations that are unsafe by construction in production. */
export function validateEnvironmentSafety(values: EnvironmentVariables): void {
  if (!isProductionEnvironment(values)) {
    return;
  }

  const issues: string[] = [];

  for (const name of ['NEXT_PUBLIC_APP_URL', 'NEXT_PUBLIC_SUPABASE_URL'] as const) {
    if (!isSecurePublicUrl(values[name])) {
      issues.push(`${name}:https-required`);
    }
  }

  const sentryDsn = values.NEXT_PUBLIC_SENTRY_DSN;
  if (isPresent(sentryDsn) && !isValidSentryDsn(sentryDsn)) {
    issues.push('NEXT_PUBLIC_SENTRY_DSN:https-required');
  }

  const posthogHost = values.NEXT_PUBLIC_POSTHOG_HOST;
  if (isPresent(posthogHost) && !isSecurePublicUrl(posthogHost)) {
    issues.push('NEXT_PUBLIC_POSTHOG_HOST:https-required');
  }

  for (const name of [
    'NEXT_PUBLIC_SUPABASE_ANON_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'RESEND_API_KEY',
    'CRON_SECRET',
    'UPSTASH_REDIS_REST_TOKEN',
  ] as const) {
    addRequiredSecretIssue(issues, values, name);
  }

  for (const name of ['GROQ_API_KEY', 'NEXT_PUBLIC_POSTHOG_KEY'] as const) {
    if (isPlaceholder(values[name])) {
      issues.push(`${name}:placeholder`);
    }
  }

  if (
    !isPresent(values.RESEND_FROM_EMAIL) ||
    values.RESEND_FROM_EMAIL === 'Tëër <noreply@lokatrack.dev>'
  ) {
    issues.push('RESEND_FROM_EMAIL:explicit-production-value-required');
  }

  if (!isAes256GcmKey(values.SHOPIFY_TOKEN_ENCRYPTION_KEY)) {
    issues.push('SHOPIFY_TOKEN_ENCRYPTION_KEY:64-hex-required');
  }

  if (isPresent(values.SHOPIFY_TOKEN_ENCRYPTION_KEY_PREVIOUS)) {
    if (!isAes256GcmKey(values.SHOPIFY_TOKEN_ENCRYPTION_KEY_PREVIOUS)) {
      issues.push('SHOPIFY_TOKEN_ENCRYPTION_KEY_PREVIOUS:64-hex-required');
    } else if (
      values.SHOPIFY_TOKEN_ENCRYPTION_KEY_PREVIOUS === values.SHOPIFY_TOKEN_ENCRYPTION_KEY
    ) {
      issues.push('SHOPIFY_TOKEN_ENCRYPTION_KEY_PREVIOUS:must-differ');
    }
  }

  const upstashUrl = values.UPSTASH_REDIS_REST_URL;
  if (!isPresent(upstashUrl) || !isSecurePublicUrl(upstashUrl)) {
    issues.push('UPSTASH_REDIS_REST_URL:https-required');
  }

  for (const [keyName, secretName] of SHOPIFY_APP_SECRET_PAIRS) {
    const hasKey = isPresent(values[keyName]);
    const hasSecret = isPresent(values[secretName]);
    if (hasKey !== hasSecret) {
      issues.push(`${keyName}/${secretName}:pair-required`);
      continue;
    }
    if (hasKey && (isPlaceholder(values[keyName]) || isPlaceholder(values[secretName]))) {
      issues.push(`${keyName}/${secretName}:placeholder`);
    }
  }

  if (values.E2E_TEST_MODE === '1' || values.E2E_PROD_BUILD === '1') {
    issues.push('E2E_TEST_MODE:E2E-only');
  }
  if (values.ENABLE_PRIMITIVES_DEMO === '1') {
    issues.push('ENABLE_PRIMITIVES_DEMO:test-only');
  }
  if (values.NEXT_PUBLIC_DISABLE_UIR === '1') {
    issues.push('NEXT_PUBLIC_DISABLE_UIR:test-only');
  }

  if (issues.length > 0) {
    throw new Error(`Unsafe production environment configuration: ${issues.join(', ')}`);
  }
}
