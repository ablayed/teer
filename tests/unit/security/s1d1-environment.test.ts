import {
  isProductionEnvironment,
  validateEnvironmentSafety,
} from '@/lib/security/environment-validation';
import { describe, expect, it } from 'vitest';

const activeKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const previousKey = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';

function productionEnvironment(overrides: Record<string, string | undefined> = {}) {
  return {
    NODE_ENV: 'production',
    VERCEL_ENV: 'production',
    NEXT_PUBLIC_APP_URL: 'https://app.teer.example.com',
    NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'production-anon-key',
    SUPABASE_SERVICE_ROLE_KEY: 'production-service-role-key',
    RESEND_API_KEY: 'production-resend-key',
    RESEND_FROM_EMAIL: 'Tëër <no-reply@app.teer.example.com>',
    CRON_SECRET: 'production-cron-secret',
    SHOPIFY_TOKEN_ENCRYPTION_KEY: activeKey,
    UPSTASH_REDIS_REST_URL: 'https://redis.upstash.io',
    UPSTASH_REDIS_REST_TOKEN: 'production-upstash-token',
    ...overrides,
  };
}

describe('S1D-1 production environment validation', () => {
  it('accepts a complete secure production shape without inspecting secret values', () => {
    expect(isProductionEnvironment(productionEnvironment())).toBe(true);
    expect(() => validateEnvironmentSafety(productionEnvironment())).not.toThrow();
  });

  it('rejects local or insecure endpoints in production', () => {
    expect(() =>
      validateEnvironmentSafety(
        productionEnvironment({
          NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
          NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
        }),
      ),
    ).toThrow(/NEXT_PUBLIC_APP_URL:https-required/);

    expect(() =>
      validateEnvironmentSafety(
        productionEnvironment({
          NEXT_PUBLIC_APP_URL: 'https://user:password@app.teer.example.com',
        }),
      ),
    ).toThrow(/NEXT_PUBLIC_APP_URL:https-required/);
  });

  it('rejects malformed encryption keys without echoing values', () => {
    const unsafeValue = 'S1D1_SYNTHETIC_SECRET_VALUE';
    expect(() =>
      validateEnvironmentSafety(
        productionEnvironment({ SHOPIFY_TOKEN_ENCRYPTION_KEY: unsafeValue }),
      ),
    ).toThrow(/SHOPIFY_TOKEN_ENCRYPTION_KEY:64-hex-required/);

    try {
      validateEnvironmentSafety(
        productionEnvironment({ SHOPIFY_TOKEN_ENCRYPTION_KEY: unsafeValue }),
      );
    } catch (error) {
      expect(String(error)).not.toContain(unsafeValue);
    }
  });

  it('rejects incomplete secret pairs and test-only modes in production', () => {
    expect(() =>
      validateEnvironmentSafety(
        productionEnvironment({
          UPSTASH_REDIS_REST_TOKEN: undefined,
          SHOPIFY_API_KEY: 'production-client-id',
          E2E_TEST_MODE: '1',
        }),
      ),
    ).toThrow(/UPSTASH_REDIS_REST_TOKEN:missing/);

    expect(() => validateEnvironmentSafety(productionEnvironment({ E2E_TEST_MODE: '1' }))).toThrow(
      /E2E_TEST_MODE:E2E-only/,
    );
  });

  it('allows local and Preview configurations to use local endpoints', () => {
    expect(isProductionEnvironment({ NODE_ENV: 'development' })).toBe(false);
    expect(() =>
      validateEnvironmentSafety({
        NODE_ENV: 'production',
        VERCEL_ENV: 'preview',
        NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
        NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
      }),
    ).not.toThrow();
  });

  it('accepts a previous key only when it is a distinct valid AES-256 key', () => {
    expect(() =>
      validateEnvironmentSafety(
        productionEnvironment({ SHOPIFY_TOKEN_ENCRYPTION_KEY_PREVIOUS: previousKey }),
      ),
    ).not.toThrow();

    expect(() =>
      validateEnvironmentSafety(
        productionEnvironment({
          SHOPIFY_TOKEN_ENCRYPTION_KEY_PREVIOUS: activeKey,
        }),
      ),
    ).toThrow(/SHOPIFY_TOKEN_ENCRYPTION_KEY_PREVIOUS:must-differ/);
  });
});
