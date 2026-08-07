export const PUBLIC_BROWSER_ENV_NAMES = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'NEXT_PUBLIC_SENTRY_DSN',
  'NEXT_PUBLIC_POSTHOG_KEY',
  'NEXT_PUBLIC_POSTHOG_HOST',
  'NEXT_PUBLIC_APP_URL',
  'NEXT_PUBLIC_SUPPORT_WHATSAPP',
  'NEXT_PUBLIC_SUPPORT_EMAIL',
] as const;

export const SERVER_ONLY_ENV_NAMES = [
  'SUPABASE_SERVICE_ROLE_KEY',
  'RESEND_API_KEY',
  'CRON_SECRET',
  'GROQ_API_KEY',
  'SHOPIFY_API_SECRET',
  'SHOPIFY_PILOTE_API_SECRET',
  'SHOPIFY_MARCHAND_API_SECRET',
  'SHOPIFY_KOBA_API_SECRET',
  'SHOPIFY_TOKEN_ENCRYPTION_KEY',
  'SHOPIFY_TOKEN_ENCRYPTION_KEY_PREVIOUS',
  'UPSTASH_REDIS_REST_TOKEN',
  'SENTRY_AUTH_TOKEN',
  'BACKUP_ENCRYPTION_KEY',
  'DATABASE_URL',
  'DIRECT_URL',
  'POSTGRES_PASSWORD',
  'SUPABASE_DB_PASSWORD',
] as const;

export type DeploymentEnvironment = 'local' | 'test' | 'preview' | 'production';

export function classifyDeploymentEnvironment(values: {
  NODE_ENV?: string;
  VERCEL_ENV?: string;
  CI?: string;
}): DeploymentEnvironment {
  if (values.VERCEL_ENV === 'preview') {
    return 'preview';
  }
  if (values.VERCEL_ENV === 'production' || values.NODE_ENV === 'production') {
    return 'production';
  }
  if (values.CI === 'true' || values.CI === '1' || values.NODE_ENV === 'test') {
    return 'test';
  }
  return 'local';
}

export function isServerOnlyEnvironmentName(name: string): boolean {
  return (SERVER_ONLY_ENV_NAMES as readonly string[]).includes(name);
}

export function isPublicBrowserEnvironmentName(name: string): boolean {
  return (PUBLIC_BROWSER_ENV_NAMES as readonly string[]).includes(name);
}
