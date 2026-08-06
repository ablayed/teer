import { spawnSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  archiveContainsPlaintext,
  createEncryptedBackup,
  extractEncryptedBackup,
} from './s1d2-backup-format.mjs';
import { restoreEncryptedBackupToLocal } from './s1d2-restore.mjs';

const CONTAINER = 'supabase_db_teer-dev';
const fixture = {
  userA: '00000000-0000-0000-0000-000000000001',
  userB: '00000000-0000-0000-0000-000000000002',
  tenantA: '00000000-0000-0000-0000-000000000011',
  tenantB: '00000000-0000-0000-0000-000000000012',
  customerA: '00000000-0000-0000-0000-000000000021',
  customerB: '00000000-0000-0000-0000-000000000022',
  shopA: '00000000-0000-0000-0000-000000000031',
  shopB: '00000000-0000-0000-0000-000000000032',
  orderA: '00000000-0000-0000-0000-000000000041',
  orderB: '00000000-0000-0000-0000-000000000042',
  addressA: '00000000-0000-0000-0000-000000000051',
  addressB: '00000000-0000-0000-0000-000000000052',
  bucket: 's1d2-synthetic',
  object: '00000000-0000-0000-0000-000000000061',
};
const syntheticToken = 's1d2-synthetic-shopify-token';
const syntheticStorageBytes = Buffer.from('s1d2-synthetic-storage-object', 'utf8');
const syntheticShopifyKey = Buffer.alloc(32, 0x2a);
let currentStage = 'initialization';

function fail() {
  throw new Error('local backup cycle failed');
}

function sql(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function safeDatabaseName(value) {
  if (!/^s1d2_(source|target)_[a-z0-9]+$/.test(value)) fail();
  return value;
}

function docker(args, input, { allowFailure = false } = {}) {
  const result = spawnSync('docker', ['exec', '-i', CONTAINER, ...args], {
    input,
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (!allowFailure && (result.error || result.status !== 0)) {
    fail();
  }
  return result.stdout ?? Buffer.alloc(0);
}

function localContainerCheck() {
  const result = spawnSync('docker', ['inspect', '--format', '{{.State.Running}}', CONTAINER], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error || result.status !== 0 || result.stdout.trim() !== 'true') fail();
}

function psql(database, query) {
  return docker([
    'psql',
    '-U',
    'postgres',
    '-d',
    database,
    '-v',
    'ON_ERROR_STOP=1',
    '-Atqc',
    query,
  ]);
}

function psqlInput(database, input) {
  docker(['psql', '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1'], input);
}

function cryptoToken() {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', syntheticShopifyKey, iv);
  const ciphertext = Buffer.concat([cipher.update(syntheticToken, 'utf8'), cipher.final()]);
  return [iv.toString('hex'), cipher.getAuthTag().toString('hex'), ciphertext.toString('hex')].join(
    ':',
  );
}

function decryptCryptoToken(value) {
  const [ivHex, tagHex, ciphertextHex] = value.split(':');
  if (!ivHex || !tagHex || !ciphertextHex) fail();
  try {
    const decipherInstance = createDecipheriv(
      'aes-256-gcm',
      syntheticShopifyKey,
      Buffer.from(ivHex, 'hex'),
    );
    decipherInstance.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([
      decipherInstance.update(Buffer.from(ciphertextHex, 'hex')),
      decipherInstance.final(),
    ]).toString('utf8');
  } catch {
    fail();
  }
}

function schemaBootstrap() {
  return `
drop schema if exists public cascade;
drop schema if exists auth cascade;
drop schema if exists storage cascade;
drop schema if exists supabase_migrations cascade;
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm with schema extensions;
`;
}

function fixtureSql(token) {
  return `
set session_replication_role = replica;
insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  (${sql(fixture.userA)}, 'authenticated', 'authenticated', 's1d2-user-a@example.invalid', '{}'::jsonb, '{}'::jsonb, now(), now()),
  (${sql(fixture.userB)}, 'authenticated', 'authenticated', 's1d2-user-b@example.invalid', '{}'::jsonb, '{}'::jsonb, now(), now());

insert into public.merchant_account (id, name, owner_user_id)
values
  (${sql(fixture.tenantA)}, 'S1D2 Synthetic Tenant A', ${sql(fixture.userA)}),
  (${sql(fixture.tenantB)}, 'S1D2 Synthetic Tenant B', ${sql(fixture.userB)});

insert into public.merchant_member (merchant_account_id, user_id, role)
values
  (${sql(fixture.tenantA)}, ${sql(fixture.userA)}, 'owner'),
  (${sql(fixture.tenantB)}, ${sql(fixture.userB)}, 'owner');

insert into public.shop (id, merchant_account_id, shop_domain, access_token_encrypted, scopes)
values
  (${sql(fixture.shopA)}, ${sql(fixture.tenantA)}, 's1d2-a.example.invalid', ${sql(token)}, 'read_orders'),
  (${sql(fixture.shopB)}, ${sql(fixture.tenantB)}, 's1d2-b.example.invalid', ${sql(token)}, 'read_orders');

insert into public.customer (id, merchant_account_id, shopify_customer_id, full_name, phone, shipping_address)
values
  (${sql(fixture.customerA)}, ${sql(fixture.tenantA)}, 's1d2-customer-a', 'S1D2 Synthetic Customer A', '+221770000001', '{"city":"Dakar","line1":"synthetic"}'::jsonb),
  (${sql(fixture.customerB)}, ${sql(fixture.tenantB)}, 's1d2-customer-b', 'S1D2 Synthetic Customer B', '+221770000002', '{"city":"Dakar","line1":"synthetic"}'::jsonb);

insert into public.orders (id, merchant_account_id, shop_id, customer_id, shopify_order_id, order_number, shipping_address)
values
  (${sql(fixture.orderA)}, ${sql(fixture.tenantA)}, ${sql(fixture.shopA)}, ${sql(fixture.customerA)}, 's1d2-order-a', 'S1D2-A', '{"city":"Dakar","line1":"synthetic"}'::jsonb),
  (${sql(fixture.orderB)}, ${sql(fixture.tenantB)}, ${sql(fixture.shopB)}, ${sql(fixture.customerB)}, 's1d2-order-b', 'S1D2-B', '{"city":"Dakar","line1":"synthetic"}'::jsonb);

insert into public.delivery_address (id, merchant_account_id, customer_id, order_id, quartier_commune, telephone_principal)
values
  (${sql(fixture.addressA)}, ${sql(fixture.tenantA)}, ${sql(fixture.customerA)}, ${sql(fixture.orderA)}, 'S1D2 Synthetic A', '+221770000001'),
  (${sql(fixture.addressB)}, ${sql(fixture.tenantB)}, ${sql(fixture.customerB)}, ${sql(fixture.orderB)}, 'S1D2 Synthetic B', '+221770000002');

insert into public.webhook_event (shopify_webhook_id, topic, shop_domain)
values ('s1d2-webhook-event', 'orders/create', 's1d2-a.example.invalid');

insert into public.audit_log (merchant_account_id, actor_user_id, action, resource_type, resource_id, payload)
values (${sql(fixture.tenantA)}, ${sql(fixture.userA)}, 's1d2_synthetic_audit', 'synthetic', ${sql(fixture.orderA)}, '{"synthetic":true}'::jsonb);

insert into storage.buckets (id, name, public)
values (${sql(fixture.bucket)}, ${sql(fixture.bucket)}, false);

insert into storage.objects (id, bucket_id, name, owner_id, metadata, user_metadata)
values (${sql(fixture.object)}, ${sql(fixture.bucket)}, 's1d2/synthetic-object.bin', ${sql(fixture.userA)}, '{"mimetype":"application/octet-stream","size":31}'::jsonb, '{"synthetic":true}'::jsonb);
set session_replication_role = origin;
`;
}

function privilegesSql() {
  return `
grant usage on schema public to authenticated;
grant select on public.merchant_account, public.merchant_member, public.shop, public.customer,
  public.orders, public.delivery_address, public.audit_log to authenticated;
grant usage on schema storage to authenticated;
grant select on storage.buckets, storage.objects to authenticated;
`;
}

function invariantQuery() {
  return `select concat(
    (select count(*) from auth.users where id in (${sql(fixture.userA)}, ${sql(fixture.userB)})), '|',
    (select count(*) from public.merchant_account where id in (${sql(fixture.tenantA)}, ${sql(fixture.tenantB)})), '|',
    (select count(*) from public.customer where id in (${sql(fixture.customerA)}, ${sql(fixture.customerB)})), '|',
    (select count(*) from public.orders where id in (${sql(fixture.orderA)}, ${sql(fixture.orderB)})), '|',
    (select count(*) from public.delivery_address where id in (${sql(fixture.addressA)}, ${sql(fixture.addressB)})), '|',
    (select count(*) from public.webhook_event where shopify_webhook_id = 's1d2-webhook-event'), '|',
    (select count(*) from public.audit_log where action = 's1d2_synthetic_audit'), '|',
    (select count(*) from storage.buckets where id = 's1d2-synthetic'), '|',
    (select count(*) from storage.objects where id = ${sql(fixture.object)})
  );`;
}

function structuralQuery() {
  return `select concat(
    (select count(*) from pg_class where relnamespace = 'public'::regnamespace and relname in ('customer','orders','delivery_address','webhook_event','audit_log') and relrowsecurity and relforcerowsecurity), '|',
    (select count(*) from pg_policies where schemaname = 'public' and tablename in ('customer','orders','delivery_address')), '|',
    (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid where not t.tgisinternal and t.tgenabled <> 'D' and t.tgname in ('customer_set_updated_at','orders_set_updated_at','delivery_address_set_updated_at')), '|',
    (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname in ('is_member_of','set_updated_at')), '|',
    (select count(*) from supabase_migrations.schema_migrations), '|',
    (select count(*) from pg_extension where extname in ('pgcrypto','uuid-ossp','pg_trgm'))
  );`;
}

function rlsQuery() {
  return `begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', ${sql(fixture.userA)}, true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select concat(
  (select count(*) from public.customer), '|',
  (select count(*) from public.orders), '|',
  (select count(*) from public.delivery_address), '|',
  (select count(*) from public.merchant_account)
);
rollback;`;
}

function appendOnlyQuery() {
  return `select concat(
    (select has_table_privilege('authenticated', 'public.audit_log', 'UPDATE')::int), '|',
    (select has_table_privilege('authenticated', 'public.audit_log', 'DELETE')::int), '|',
    (select count(*) from pg_policies where schemaname = 'public' and tablename = 'audit_log')
  );`;
}

function createDatabase(name) {
  safeDatabaseName(name);
  psql('postgres', `create database ${name};`);
}

function dropDatabase(name) {
  if (!/^s1d2_(source|target)_[a-z0-9]+$/.test(name)) return;
  docker(
    [
      'psql',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-v',
      'ON_ERROR_STOP=0',
      '-c',
      `drop database if exists ${name} with (force);`,
    ],
    undefined,
    { allowFailure: true },
  );
}

function assertEqual(actual, expected) {
  if (actual.trim() !== expected) fail();
}

async function main() {
  const started = performance.now();
  const nonce = randomBytes(5).toString('hex');
  const sourceDb = safeDatabaseName(`s1d2_source_${nonce}`);
  const targetDb = safeDatabaseName(`s1d2_target_${nonce}`);
  const workspace = await mkdtemp(join(tmpdir(), 's1d2-cycle-'));
  const components = join(workspace, 'components');
  const extracted = join(workspace, 'extracted');
  const archivePath = join(workspace, 'backup.s1d2');
  const backupKey = Buffer.alloc(32, 0x5a);
  let sourceCreated = false;
  let targetCreated = false;
  try {
    currentStage = 'local-container-check';
    localContainerCheck();
    currentStage = 'schema-dump';
    const schemaDump = docker([
      'pg_dump',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '--schema-only',
      '--no-owner',
      '--no-privileges',
      '--schema=public',
      '--schema=auth',
      '--schema=storage',
      '--schema=supabase_migrations',
    ]);
    currentStage = 'source-database-create';
    createDatabase(sourceDb);
    sourceCreated = true;
    currentStage = 'source-schema-bootstrap';
    psqlInput(sourceDb, Buffer.from(schemaBootstrap(), 'utf8'));
    currentStage = 'source-schema-restore';
    psqlInput(sourceDb, schemaDump);
    psqlInput(sourceDb, Buffer.from(privilegesSql(), 'utf8'));
    currentStage = 'fixture-load';
    psqlInput(sourceDb, Buffer.from(fixtureSql(cryptoToken()), 'utf8'));
    currentStage = 'source-invariants';
    assertEqual(psql(sourceDb, invariantQuery()).toString('utf8'), '2|2|2|2|2|1|1|1|1');
    const sourceStructural = psql(sourceDb, structuralQuery()).toString('utf8').trim();
    const sourceAppendOnly = psql(sourceDb, appendOnlyQuery()).toString('utf8').trim();

    currentStage = 'full-dump';
    const fullDump = docker([
      'pg_dump',
      '-U',
      'postgres',
      '-d',
      sourceDb,
      '--no-owner',
      '--no-privileges',
      '--schema=public',
      '--schema=auth',
      '--schema=storage',
      '--schema=supabase_migrations',
    ]);
    currentStage = 'archive-build';
    await mkdir(components, { recursive: true });
    await writeFile(join(components, 'db.sql'), fullDump, { flag: 'wx' });
    await writeFile(join(components, 'roles-and-privileges.sql'), privilegesSql(), { flag: 'wx' });
    await writeFile(join(components, 'storage-object-0001.bin'), syntheticStorageBytes, {
      flag: 'wx',
    });
    await writeFile(
      join(components, 'storage-map.json'),
      JSON.stringify({
        component: 'storage-object-0001.bin',
        bucket: fixture.bucket,
        path: 's1d2/synthetic-object.bin',
        source: 'local-synthetic-fixture',
      }),
      { flag: 'wx' },
    );
    await createEncryptedBackup({
      inputDir: components,
      outputPath: archivePath,
      key: backupKey,
      metadata: {
        source: 'supabase-local',
        databaseSchemas: ['public', 'auth', 'storage', 'supabase_migrations'],
      },
    });
    if (await archiveContainsPlaintext({ archivePath, plaintext: 'S1D2 Synthetic Customer A' }))
      fail();
    if (await archiveContainsPlaintext({ archivePath, plaintext: syntheticToken })) fail();
    await rm(components, { recursive: true, force: true });

    currentStage = 'target-database-create';
    createDatabase(targetDb);
    targetCreated = true;
    currentStage = 'target-schema-bootstrap';
    psqlInput(targetDb, Buffer.from(schemaBootstrap(), 'utf8'));
    currentStage = 'archive-restore';
    await restoreEncryptedBackupToLocal({
      archivePath,
      container: CONTAINER,
      database: targetDb,
      key: backupKey,
      workspaceDir: extracted,
      confirmLocalRestore: true,
    });
    currentStage = 'post-restore-counts';
    assertEqual(psql(targetDb, invariantQuery()).toString('utf8'), '2|2|2|2|2|1|1|1|1');
    currentStage = 'post-restore-structure';
    assertEqual(psql(targetDb, structuralQuery()).toString('utf8'), sourceStructural);
    currentStage = 'post-restore-rls';
    assertEqual(
      psql(targetDb, rlsQuery()).toString('utf8').trim().split(/\r?\n/).at(-1),
      '1|1|1|1',
    );
    currentStage = 'post-restore-audit';
    assertEqual(psql(targetDb, appendOnlyQuery()).toString('utf8'), sourceAppendOnly);
    currentStage = 'post-restore-shopify-token';
    const restoredToken = docker([
      'psql',
      '-U',
      'postgres',
      '-d',
      targetDb,
      '-Atqc',
      `select access_token_encrypted from public.shop where id = ${sql(fixture.shopA)};`,
    ])
      .toString('utf8')
      .trim();
    if (decryptCryptoToken(restoredToken) !== syntheticToken) fail();
    currentStage = 'post-restore-storage';
    const storageProbe = await extractEncryptedBackup({
      archivePath,
      outputDir: extracted,
      key: backupKey,
    });
    const restoredObject = await readFile(join(extracted, 'storage-object-0001.bin'));
    if (!restoredObject.equals(syntheticStorageBytes)) fail();
    if (storageProbe.payload.components.length !== 4) fail();
    await rm(extracted, { recursive: true, force: true });
    await rm(archivePath, { force: true });
    const durationMs = Math.round(performance.now() - started);
    process.stdout.write(`S1D2_LOCAL_CYCLE_OK duration_ms=${durationMs} components=4\n`);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    if (targetCreated) dropDatabase(targetDb);
    if (sourceCreated) dropDatabase(sourceDb);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((_error) => {
    process.stderr.write(`local backup cycle failed at ${currentStage}\n`);
    process.exitCode = 1;
  });
}
