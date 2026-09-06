import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const admin = { from: vi.fn() };
  return {
    admin,
    createMaintenanceSupabaseClient: vi.fn(() => admin),
    decryptToken: vi.fn(),
    shopifyGraphQL: vi.fn(),
    refreshAccessToken: vi.fn(),
  };
});

vi.mock('../../../scripts/lib/maintenance-supabase-client.mjs', () => ({
  createMaintenanceSupabaseClient: mocks.createMaintenanceSupabaseClient,
}));
vi.mock('../../../lib/shopify/crypto.ts', () => ({
  decryptToken: mocks.decryptToken,
  encryptToken: vi.fn(),
}));
vi.mock('../../../lib/shopify/graphql.ts', () => ({ shopifyGraphQL: mocks.shopifyGraphQL }));
vi.mock('../../../lib/shopify/oauth.ts', () => ({ refreshAccessToken: mocks.refreshAccessToken }));

type MigrationModule = {
  planConnection(input: ReturnType<typeof planInput>): Promise<{
    blocked: boolean;
    reason?: string;
    topics?: unknown[];
  }>;
  loadPlanActiveConnections(shopDomain: string): Promise<unknown>;
  reportControlledFailure(error: unknown): void;
};

let migration: MigrationModule;

async function captureFailure(operation: () => Promise<unknown>) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let result: unknown;
  const previousLog = console.log;
  const previousError = console.error;
  console.log = (...args) => stdout.push(args.join(' '));
  console.error = (...args) => stderr.push(args.join(' '));

  try {
    result = await operation();
  } catch (error) {
    migration.reportControlledFailure(error);
  } finally {
    console.log = previousLog;
    console.error = previousError;
  }

  return { stdout: stdout.join('\n'), stderr: stderr.join('\n'), result };
}

function sensitiveError(label: string) {
  return new Error(`outer-${label}-sentinel`, {
    cause: new Error(`inner-${label}-sentinel`, {
      cause: { nested: `${label}-deep-sentinel` },
    }),
  });
}

function planInput(shop: Record<string, unknown> = {}) {
  return {
    connection: { id: 'connection-sentinel' },
    shop: {
      shop_domain: 'pilot.myshopify.com',
      access_token_encrypted: 'encrypted-token-sentinel',
      access_token_expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
      ...shop,
    },
    app: { label: 'pilot' },
    knownToken: null,
  };
}

describe('erreurs des frontières du plan', () => {
  beforeAll(async () => {
    const previousArgv = process.argv;
    const previousEnvironment = new Map(
      Object.entries({
        NODE_ENV: process.env.NODE_ENV,
        WEBHOOK_MIGRATION_SUPABASE_URL: process.env.WEBHOOK_MIGRATION_SUPABASE_URL,
        WEBHOOK_MIGRATION_SUPABASE_SERVICE_ROLE_KEY:
          process.env.WEBHOOK_MIGRATION_SUPABASE_SERVICE_ROLE_KEY,
        WEBHOOK_MIGRATION_SUPABASE_ALLOWED_ORIGIN:
          process.env.WEBHOOK_MIGRATION_SUPABASE_ALLOWED_ORIGIN,
        WEBHOOK_PUBLIC_BASE_URL: process.env.WEBHOOK_PUBLIC_BASE_URL,
        SHOPIFY_TOKEN_ENCRYPTION_KEY: process.env.SHOPIFY_TOKEN_ENCRYPTION_KEY,
        SHOPIFY_KOBA_API_KEY: process.env.SHOPIFY_KOBA_API_KEY,
        SHOPIFY_KOBA_API_SECRET: process.env.SHOPIFY_KOBA_API_SECRET,
      }),
    );

    process.argv = [
      process.execPath,
      'scripts/webhook-subscription-migration.mjs',
      '--plan',
      '--shop-domain',
      'pilot.myshopify.com',
    ];
    Object.assign(process.env, {
      NODE_ENV: 'test',
      WEBHOOK_MIGRATION_SUPABASE_URL: 'https://maintenance.example.test',
      WEBHOOK_MIGRATION_SUPABASE_SERVICE_ROLE_KEY: 'service-role-test-sentinel',
      WEBHOOK_MIGRATION_SUPABASE_ALLOWED_ORIGIN: 'https://maintenance.example.test',
      WEBHOOK_PUBLIC_BASE_URL: 'https://webhooks.example.test',
      SHOPIFY_TOKEN_ENCRYPTION_KEY: 'encryption-test-sentinel',
      SHOPIFY_KOBA_API_KEY: 'client-test-sentinel',
      SHOPIFY_KOBA_API_SECRET: 'secret-test-sentinel',
    });

    migration = (await import(
      new URL('../../../scripts/webhook-subscription-migration.mjs', import.meta.url).href
    )) as MigrationModule;

    process.argv = previousArgv;
    for (const [key, value] of previousEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createMaintenanceSupabaseClient.mockReturnValue(mocks.admin);
  });

  it('nomme une lecture DB du plan et ne restitue aucune sentinelle imbriquée', async () => {
    const query = {
      select: vi.fn(() => query),
      range: vi.fn(() => Promise.reject(sensitiveError('db'))),
      eq: vi.fn(() => query),
      in: vi.fn(() => query),
    };
    mocks.admin.from.mockReturnValue(query);

    const output = await captureFailure(() =>
      migration.loadPlanActiveConnections('pilot.myshopify.com'),
    );

    expect(output.stderr).toContain('cause=db_read_failure');
    expect(output.stdout).toBe('');
    expect(output.stderr).not.toContain('sentinel');
  });

  it('conserve token_error pour un déchiffrement refusé', async () => {
    mocks.decryptToken.mockImplementation(() => {
      throw sensitiveError('token');
    });

    const output = await captureFailure(() => migration.planConnection(planInput()));

    expect(output.result).toMatchObject({ blocked: true, reason: 'token_error' });
    expect(output.stdout).toBe('');
    expect(output.stderr).toBe('');
  });

  it('nomme une exception inattendue à la frontière du jeton sans écraser le motif précis', async () => {
    const input = planInput();
    Object.defineProperty(input.shop, 'access_token_encrypted', {
      get(): never {
        throw sensitiveError('token-boundary');
      },
    });

    const output = await captureFailure(() => migration.planConnection(input));

    expect(output.stderr).toContain('cause=token_decryption_failure');
    expect(output.stderr).not.toContain('sentinel');
  });

  it('nomme une lecture Shopify et masque les erreurs imbriquées', async () => {
    mocks.decryptToken.mockReturnValue('access-token-sentinel');
    mocks.shopifyGraphQL.mockRejectedValue(sensitiveError('shopify'));

    const output = await captureFailure(() => migration.planConnection(planInput()));

    expect(output.stderr).toContain('cause=shopify_read_failure');
    expect(output.stdout).toBe('');
    expect(output.stderr).not.toContain('sentinel');
  });

  it('retombe sur unknown_failure hors des frontières marquées', async () => {
    mocks.decryptToken.mockReturnValue('access-token-sentinel');
    const node = {
      get topic(): never {
        throw sensitiveError('unknown');
      },
    };
    mocks.shopifyGraphQL.mockResolvedValue({ webhookSubscriptions: { edges: [{ node }] } });

    const output = await captureFailure(() => migration.planConnection(planInput()));

    expect(output.stderr).toContain('cause=unknown_failure');
    expect(output.stderr).not.toContain('sentinel');
  });

  it('poursuit avec un jeton valide et des lectures saines', async () => {
    mocks.decryptToken.mockReturnValue('access-token-sentinel');
    mocks.shopifyGraphQL.mockResolvedValue({ webhookSubscriptions: { edges: [] } });

    const output = await captureFailure(() => migration.planConnection(planInput()));

    expect(output.result).toMatchObject({ blocked: false });
    expect((output.result as { topics?: unknown[] }).topics?.length).toBeGreaterThan(0);
    expect(output.stdout).toBe('');
    expect(output.stderr).toBe('');
  });
});
