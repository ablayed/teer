import { assertPostgresTarget } from '@/lib/security/supabase-target-policy';
import {
  DSAR_TEST_AUDIT_FAILURE_HEADER,
  SHOPIFY_DSAR_BUCKET,
  isDsarAuditFailureTestHookEnabled,
} from '@/lib/shopify/dsar';
import { type Page, expect, test } from '@playwright/test';
import { Client } from 'pg';
import { assertLocalSupabase } from './helpers/assert-local-supabase';
import {
  type AdminClient,
  adminClient,
  cleanupUsers,
  createConfirmedUser,
  e2eEmail,
  e2ePassword,
  hasSupabaseAdmin,
  loginViaForm,
  supabaseUrl,
  waitForMerchant,
} from './helpers/auth';

type Fixture = {
  admin: AdminClient;
  email: string;
  userId: string;
  tenantId: string;
  shopId: string;
  artifactId: string;
  storagePath: string;
  marker: string;
};

type AuthorizationResponse = {
  downloadToken: string;
  downloadPath: string;
};

const createdUserIds: string[] = [];
const createdStoragePaths: string[] = [];

test.setTimeout(120_000);

function requireLocalE2E(): void {
  if (!hasSupabaseAdmin) {
    throw new Error('DSAR E2E requires the local Supabase service role');
  }
  assertLocalSupabase(supabaseUrl);
}

function failFixture(message: string): never {
  throw new Error(`DSAR E2E fixture failure: ${message}`);
}

async function createShop(admin: AdminClient, tenantId: string, label: string): Promise<string> {
  const { data, error } = await admin
    .from('shop')
    .insert({
      merchant_account_id: tenantId,
      shop_domain: `s1c4-${label}-${crypto.randomUUID()}.myshopify.com`,
      access_token_encrypted: 's1c4-synthetic-encrypted-token',
      scopes: 'read_orders',
    })
    .select('id')
    .single();
  if (error || !data) failFixture('shop creation failed');
  return data.id as string;
}

async function createArtifact(
  admin: AdminClient,
  tenantId: string,
  shopId: string,
  label: string,
): Promise<Pick<Fixture, 'artifactId' | 'storagePath' | 'marker'>> {
  const marker = `S1C4_SYNTHETIC_MARKER_${label}`;
  const storagePath = `s1c4/${tenantId}/${crypto.randomUUID()}.json`;
  const body = Buffer.from(JSON.stringify({ marker }), 'utf8');
  const webhookId = crypto.randomUUID();
  const { data: event, error: eventError } = await admin
    .from('webhook_event')
    .insert({
      shop_domain: `s1c4-${label}.myshopify.com`,
      shopify_webhook_id: `s1c4-${webhookId}`,
      topic: 'customers/data_request',
      merchant_account_id: tenantId,
      shop_id: shopId,
      processed: true,
      status: 'done',
      payload: null,
    })
    .select('id')
    .single();
  if (eventError || !event) failFixture('webhook event creation failed');

  const { data: artifact, error: artifactError } = await admin
    .from('shopify_dsar_artifact')
    .insert({
      webhook_event_id: event.id,
      merchant_account_id: tenantId,
      shop_id: shopId,
      storage_bucket: SHOPIFY_DSAR_BUCKET,
      storage_path: storagePath,
      status: 'ready',
      byte_size: body.byteLength,
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      completed_at: new Date().toISOString(),
    })
    .select('id')
    .single();
  if (artifactError || !artifact) failFixture('artifact metadata creation failed');

  createdStoragePaths.push(storagePath);
  const { error: uploadError } = await admin.storage
    .from(SHOPIFY_DSAR_BUCKET)
    .upload(storagePath, body, { contentType: 'application/json', cacheControl: '0' });
  if (uploadError) failFixture('artifact upload failed');

  return { artifactId: artifact.id as string, storagePath, marker };
}

async function createOwnerFixture(label: string): Promise<Fixture> {
  const admin = adminClient();
  const email = e2eEmail(`s1c4-${label}`);
  const userId = await createConfirmedUser(admin, email);
  createdUserIds.push(userId);
  const tenantId = await waitForMerchant(admin, userId);
  const { error: onboardingError } = await admin
    .from('merchant_account')
    .update({ onboarded_at: new Date().toISOString() })
    .eq('id', tenantId);
  if (onboardingError) failFixture('merchant onboarding setup failed');
  const shopId = await createShop(admin, tenantId, label);
  const artifact = await createArtifact(admin, tenantId, shopId, label);
  return { admin, email, userId, tenantId, shopId, ...artifact };
}

async function createManager(admin: AdminClient, tenantId: string, label: string) {
  const email = e2eEmail(`s1c4-manager-${label}`);
  const userId = await createConfirmedUser(admin, email);
  createdUserIds.push(userId);

  const { error: ownAccountError } = await admin
    .from('merchant_account')
    .delete()
    .eq('owner_user_id', userId);
  if (ownAccountError) failFixture('manager account cleanup failed');

  const { error: memberError } = await admin.from('merchant_member').insert({
    merchant_account_id: tenantId,
    user_id: userId,
    role: 'manager',
  });
  if (memberError) failFixture('manager membership creation failed');
  return { email, userId };
}

async function signIn(page: Page, email: string, shopId: string): Promise<void> {
  const route = `/s/${shopId}/tableau`;
  await loginViaForm(page, email, e2ePassword, route);
  await page.waitForURL(`**${route}`);
}

function routePath(artifactId: string, shopId: string): string {
  return `/api/shopify/dsar/${artifactId}?shop_id=${shopId}`;
}

function downloadRoutePath(artifactId: string, shopId: string): string {
  return `/api/shopify/dsar/${artifactId}/download?shop_id=${shopId}`;
}

async function issueAuthorization(
  page: Page,
  fixture: Pick<Fixture, 'artifactId' | 'shopId'>,
): Promise<AuthorizationResponse> {
  const response = await page.request.get(routePath(fixture.artifactId, fixture.shopId));
  expect(response.status()).toBe(200);
  expect(response.url()).toContain(routePath(fixture.artifactId, fixture.shopId));
  expect(response.headers()['cache-control']).toBe('private, no-store, max-age=0');

  const payload = (await response.json()) as Partial<AuthorizationResponse>;
  expect(typeof payload.downloadToken).toBe('string');
  expect(payload.downloadToken?.length).toBe(64);
  expect(typeof payload.downloadPath).toBe('string');
  expect(payload.downloadPath).not.toMatch(/^https?:\/\//i);
  expect(payload.downloadPath).not.toContain('token');
  expect(payload.downloadPath).not.toContain('signed');
  return payload as AuthorizationResponse;
}

async function download(
  page: Page,
  artifactId: string,
  shopId: string,
  token: string,
  headers?: Record<string, string>,
) {
  return page.request.get(downloadRoutePath(artifactId, shopId), {
    headers: { 'x-teer-dsar-download-token': token, ...headers },
  });
}

async function expectNoArtifactContent(
  response: Awaited<ReturnType<Page['request']['get']>>,
  marker: string,
  status: number,
  errorCode: string,
): Promise<void> {
  expect(response.status()).toBe(status);
  const body = await response.body();
  expect(body.includes(Buffer.from(marker, 'utf8'))).toBe(false);
  expect(response.headers()['content-type']).toContain('application/json');
  const payload = (await response.json()) as { error?: string };
  expect(payload).toEqual({ error: errorCode });
}

async function expectArtifactDownload(
  response: Awaited<ReturnType<Page['request']['get']>>,
  marker: string,
): Promise<void> {
  expect(response.status()).toBe(200);
  expect(response.headers()['cache-control']).toBe('private, no-store, max-age=0');
  expect(response.headers().pragma).toBe('no-cache');
  expect(response.headers()['x-content-type-options']).toBe('nosniff');
  expect(response.headers()['content-type']).toContain('application/json');
  expect(response.headers()['content-disposition']).toBe('attachment; filename="dsar-export.json"');
  expect(response.headers().location).toBeUndefined();

  const body = await response.body();
  expect(body.includes(Buffer.from(marker, 'utf8'))).toBe(true);
  expect(body.byteLength).toBeGreaterThan(Buffer.byteLength(marker));
}

async function ageAuthSession(userId: string): Promise<void> {
  const dbUrl =
    process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
  assertPostgresTarget({ target: dbUrl, variableName: 'SUPABASE_DB_URL' });
  const client = new Client({ connectionString: dbUrl, connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    await client.query('update auth.users set last_sign_in_at = $1 where id = $2', [
      new Date(Date.now() - 16 * 60 * 1000).toISOString(),
      userId,
    ]);
  } finally {
    await client.end();
  }
}

test.beforeAll(() => {
  requireLocalE2E();
});

test.afterEach(async () => {
  if (!hasSupabaseAdmin) return;
  const admin = adminClient();
  for (const storagePath of createdStoragePaths.splice(0)) {
    await admin.storage.from(SHOPIFY_DSAR_BUCKET).remove([storagePath]);
  }
  await cleanupUsers(admin, createdUserIds.splice(0));
});

test.describe('S1C-4 — routes DSAR réelles et preuve fail-closed', () => {
  test('le hook d’audit est borné au contexte serveur de test local', () => {
    // Le discriminant "vraie prod" est VERCEL_ENV (cf. isProductionEnvironment,
    // lib/security/environment-validation.ts), pas NODE_ENV : la suite E2E de ce projet
    // tourne systématiquement sous `next start` (E2E_PROD_BUILD=1, cf. CLAUDE.md
    // "Validation finale E2E build-prod"), donc NODE_ENV vaut toujours 'production' ici
    // même pour un build de test. VERCEL_ENV=preview (posé par ci.yml pour toute la suite)
    // distingue ce contexte d'une vraie prod Vercel (VERCEL_ENV=production).
    const previousMode = process.env.E2E_TEST_MODE;
    const previousVercelEnv = process.env.VERCEL_ENV;
    const request = new Request('http://localhost/api/shopify/dsar/synthetic', {
      headers: { [DSAR_TEST_AUDIT_FAILURE_HEADER]: '1' },
    });

    try {
      process.env.E2E_TEST_MODE = undefined;
      process.env.VERCEL_ENV = 'preview';
      expect(isDsarAuditFailureTestHookEnabled(request)).toBe(false);

      process.env.E2E_TEST_MODE = '1';
      expect(isDsarAuditFailureTestHookEnabled(request)).toBe(true);

      process.env.VERCEL_ENV = 'production';
      expect(isDsarAuditFailureTestHookEnabled(request)).toBe(false);
    } finally {
      if (previousMode === undefined) process.env.E2E_TEST_MODE = undefined;
      else process.env.E2E_TEST_MODE = previousMode;
      if (previousVercelEnv === undefined) process.env.VERCEL_ENV = undefined;
      else process.env.VERCEL_ENV = previousVercelEnv;
    }
  });

  test('parcours nominal, headers et consommation séquentielle one-shot', async ({ page }) => {
    const fixture = await createOwnerFixture('nominal');
    await signIn(page, fixture.email, fixture.shopId);

    const authorization = await issueAuthorization(page, fixture);
    const first = await download(
      page,
      fixture.artifactId,
      fixture.shopId,
      authorization.downloadToken,
    );
    await expectArtifactDownload(first, fixture.marker);

    const second = await download(
      page,
      fixture.artifactId,
      fixture.shopId,
      authorization.downloadToken,
    );
    await expectNoArtifactContent(second, fixture.marker, 404, 'artifact_unavailable');
  });

  test('refuse acteur, tenant, boutique et artefact hors périmètre', async ({ page, browser }) => {
    const ownerA = await createOwnerFixture('isolation-a');
    const ownerB = await createOwnerFixture('isolation-b');
    const shopA2 = await createShop(ownerA.admin, ownerA.tenantId, 'isolation-a-2');
    const artifactA2 = await createArtifact(
      ownerA.admin,
      ownerA.tenantId,
      ownerA.shopId,
      'isolation-a-2',
    );
    const shopB = await createShop(ownerB.admin, ownerB.tenantId, 'isolation-b-2');
    const manager = await createManager(ownerA.admin, ownerA.tenantId, 'isolation');
    await signIn(page, ownerA.email, ownerA.shopId);
    const authorization = await issueAuthorization(page, ownerA);

    const managerContext = await browser.newContext();
    const tenantContext = await browser.newContext();
    const managerPage = await managerContext.newPage();
    const tenantPage = await tenantContext.newPage();
    try {
      await signIn(managerPage, manager.email, ownerA.shopId);
      await signIn(tenantPage, ownerB.email, ownerB.shopId);

      const otherActor = await download(
        managerPage,
        ownerA.artifactId,
        ownerA.shopId,
        authorization.downloadToken,
      );
      await expectNoArtifactContent(otherActor, ownerA.marker, 404, 'artifact_unavailable');

      const otherTenant = await download(
        tenantPage,
        ownerA.artifactId,
        shopB,
        authorization.downloadToken,
      );
      await expectNoArtifactContent(otherTenant, ownerA.marker, 404, 'artifact_unavailable');

      const otherShop = await download(
        page,
        ownerA.artifactId,
        shopA2,
        authorization.downloadToken,
      );
      await expectNoArtifactContent(otherShop, ownerA.marker, 404, 'artifact_unavailable');

      const otherArtifact = await download(
        page,
        artifactA2.artifactId,
        ownerA.shopId,
        authorization.downloadToken,
      );
      await expectNoArtifactContent(otherArtifact, ownerA.marker, 404, 'artifact_unavailable');

      const correct = await download(
        page,
        ownerA.artifactId,
        ownerA.shopId,
        authorization.downloadToken,
      );
      await expectArtifactDownload(correct, ownerA.marker);
    } finally {
      await managerContext.close();
      await tenantContext.close();
    }
  });

  test('refuse autorisation expirée sans contenu artefact', async ({ page }) => {
    const fixture = await createOwnerFixture('expired');
    await signIn(page, fixture.email, fixture.shopId);
    const authorization = await issueAuthorization(page, fixture);

    const { data: rows, error: lookupError } = await fixture.admin
      .from('shopify_dsar_download_authorization')
      .select('id')
      .eq('artifact_id', fixture.artifactId)
      .limit(1);
    if (lookupError || !rows?.[0]?.id) failFixture('authorization lookup failed');
    const { error: updateError } = await fixture.admin
      .from('shopify_dsar_download_authorization')
      .update({ expires_at: new Date(Date.now() - 1_000).toISOString() })
      .eq('id', rows[0].id as string);
    if (updateError) failFixture('authorization expiry setup failed');

    const response = await download(
      page,
      fixture.artifactId,
      fixture.shopId,
      authorization.downloadToken,
    );
    await expectNoArtifactContent(response, fixture.marker, 404, 'artifact_unavailable');
  });

  test('refuse session trop ancienne puis exige une réauthentification', async ({
    page,
    browser,
  }) => {
    const fixture = await createOwnerFixture('reauth');
    await signIn(page, fixture.email, fixture.shopId);
    const authorization = await issueAuthorization(page, fixture);
    await ageAuthSession(fixture.userId);

    const staleResponse = await download(
      page,
      fixture.artifactId,
      fixture.shopId,
      authorization.downloadToken,
    );
    await expectNoArtifactContent(staleResponse, fixture.marker, 401, 'reauthentication_required');

    const freshContext = await browser.newContext();
    const freshPage = await freshContext.newPage();
    try {
      await signIn(freshPage, fixture.email, fixture.shopId);
      const freshResponse = await download(
        freshPage,
        fixture.artifactId,
        fixture.shopId,
        authorization.downloadToken,
      );
      await expectArtifactDownload(freshResponse, fixture.marker);
    } finally {
      await freshContext.close();
    }
  });

  test('audit indisponible : refus sans octet et droit one-shot non réutilisable', async ({
    page,
  }) => {
    const fixture = await createOwnerFixture('audit-failure');
    await signIn(page, fixture.email, fixture.shopId);
    const authorization = await issueAuthorization(page, fixture);

    const refused = await download(
      page,
      fixture.artifactId,
      fixture.shopId,
      authorization.downloadToken,
      { [DSAR_TEST_AUDIT_FAILURE_HEADER]: '1' },
    );
    await expectNoArtifactContent(refused, fixture.marker, 503, 'audit_unavailable');

    const { data: rows, error: lookupError } = await fixture.admin
      .from('shopify_dsar_download_authorization')
      .select('consumed_at')
      .eq('artifact_id', fixture.artifactId)
      .limit(1);
    if (lookupError || !rows?.[0]) failFixture('authorization state lookup failed');
    expect(rows[0].consumed_at).not.toBeNull();

    const retry = await download(
      page,
      fixture.artifactId,
      fixture.shopId,
      authorization.downloadToken,
    );
    await expectNoArtifactContent(retry, fixture.marker, 404, 'artifact_unavailable');
  });

  test('deux téléchargements concurrents : un seul succès et un seul refus', async ({
    page,
    browser,
  }) => {
    const fixture = await createOwnerFixture('concurrent');
    await signIn(page, fixture.email, fixture.shopId);
    const authorization = await issueAuthorization(page, fixture);

    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    try {
      await signIn(pageA, fixture.email, fixture.shopId);
      await signIn(pageB, fixture.email, fixture.shopId);
      const responses = await Promise.all([
        download(pageA, fixture.artifactId, fixture.shopId, authorization.downloadToken),
        download(pageB, fixture.artifactId, fixture.shopId, authorization.downloadToken),
      ]);
      const successful = responses.filter((response) => response.status() === 200);
      const refused = responses.filter((response) => response.status() === 404);
      expect(successful).toHaveLength(1);
      expect(refused).toHaveLength(1);
      await expectArtifactDownload(successful[0], fixture.marker);
      await expectNoArtifactContent(refused[0], fixture.marker, 404, 'artifact_unavailable');
    } finally {
      await contextA.close();
      await contextB.close();
    }
  });
});
