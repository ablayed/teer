import { z } from 'zod';

const publicEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  NEXT_PUBLIC_SENTRY_DSN: z.string().url().optional().or(z.literal('')),
  NEXT_PUBLIC_POSTHOG_KEY: z.string().optional(),
  NEXT_PUBLIC_POSTHOG_HOST: z.string().url().optional().or(z.literal('')),
  NEXT_PUBLIC_APP_URL: z.string().url().default('http://localhost:3000'),
  // Support contact — optionnels : si absents, les boutons correspondants sont masqués.
  // Aucun domaine par défaut — le développeur renseigne ces vars dans Vercel sans redéployer.
  NEXT_PUBLIC_SUPPORT_WHATSAPP: z.string().optional(),
  NEXT_PUBLIC_SUPPORT_EMAIL: z.string().optional(),
});

const serverEnvSchema = z.object({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  RESEND_API_KEY: z.string().min(1),
  RESEND_FROM_EMAIL: z.string().min(1).default('Tëër <noreply@lokatrack.dev>'),
  CRON_SECRET: z.string().optional(),
  GROQ_API_KEY: z.string().optional(),
  SHOPIFY_API_KEY: z.string().optional(),
  SHOPIFY_API_SECRET: z.string().optional(),
  // Multi-app : credentials de la 2e app Shopify (Teer Pilote, custom). Optionnels — si absents,
  // seule Teer Dev est enregistrée. Voir lib/shopify/apps.ts.
  SHOPIFY_PILOTE_API_KEY: z.string().optional(),
  SHOPIFY_PILOTE_API_SECRET: z.string().optional(),
  // Multi-app : credentials de la 3e app Shopify (Teer Marchand, custom). Optionnels — si absents,
  // l'app n'est pas enregistrée. Voir lib/shopify/apps.ts.
  SHOPIFY_MARCHAND_API_KEY: z.string().optional(),
  SHOPIFY_MARCHAND_API_SECRET: z.string().optional(),
  // Multi-app : credentials de la 4e app Shopify (Teer Koba, custom — app créée dans l'org du
  // marchand pour un store hors de l'org Tëër). Optionnels — si absents, l'app n'est pas
  // enregistrée. Voir lib/shopify/apps.ts.
  SHOPIFY_KOBA_API_KEY: z.string().optional(),
  SHOPIFY_KOBA_API_SECRET: z.string().optional(),
  SHOPIFY_TOKEN_ENCRYPTION_KEY: z.string().optional(),
  // Rate-limiting auth par IP (Upstash Redis). Serveur uniquement (jamais NEXT_PUBLIC_).
  // Optionnelles : posées sur Vercel (Prod+Preview) → limiter actif en prod ; absentes
  // en CI/local → le limiter fait fail-open (cf. lib/security/auth-rate-limit.ts), pour
  // ne pas bloquer le build/les tests ni verrouiller les marchands (philosophie fail-open).
  UPSTASH_REDIS_REST_URL: z.string().url().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1).optional(),
});

const rawPublicEnv = {
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
  NEXT_PUBLIC_POSTHOG_KEY: process.env.NEXT_PUBLIC_POSTHOG_KEY,
  NEXT_PUBLIC_POSTHOG_HOST: process.env.NEXT_PUBLIC_POSTHOG_HOST,
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL || undefined,
  NEXT_PUBLIC_SUPPORT_WHATSAPP: process.env.NEXT_PUBLIC_SUPPORT_WHATSAPP,
  NEXT_PUBLIC_SUPPORT_EMAIL: process.env.NEXT_PUBLIC_SUPPORT_EMAIL,
};

export const publicEnv = publicEnvSchema.parse(rawPublicEnv);

export const env = {
  ...publicEnv,
  ...serverEnvSchema.parse({
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    RESEND_FROM_EMAIL: process.env.RESEND_FROM_EMAIL || undefined,
    CRON_SECRET: process.env.CRON_SECRET,
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    SHOPIFY_API_KEY: process.env.SHOPIFY_API_KEY,
    SHOPIFY_API_SECRET: process.env.SHOPIFY_API_SECRET,
    SHOPIFY_PILOTE_API_KEY: process.env.SHOPIFY_PILOTE_API_KEY,
    SHOPIFY_PILOTE_API_SECRET: process.env.SHOPIFY_PILOTE_API_SECRET,
    SHOPIFY_MARCHAND_API_KEY: process.env.SHOPIFY_MARCHAND_API_KEY,
    SHOPIFY_MARCHAND_API_SECRET: process.env.SHOPIFY_MARCHAND_API_SECRET,
    SHOPIFY_KOBA_API_KEY: process.env.SHOPIFY_KOBA_API_KEY,
    SHOPIFY_KOBA_API_SECRET: process.env.SHOPIFY_KOBA_API_SECRET,
    SHOPIFY_TOKEN_ENCRYPTION_KEY: process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY,
    UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
    UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
  }),
};
