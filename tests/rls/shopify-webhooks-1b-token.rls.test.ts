// SHOPIFY-WEBHOOKS-PER-SHOP-1B / C1 — provisionnement et rotation du jeton L3, contre
// PostgreSQL/PostgREST réels.
//
// Couche : RLS/intégration. Ce qui est prouvé ici, et qu'un double ne prouverait pas : les
// colonnes réellement écrites (grâce, `revoked_at`), et le compare-and-set — c'est la base qui
// refuse une rotation fondée sur une empreinte périmée.
import { hashWebhookTokenSecret, verifyWebhookTokenSecret } from '@/lib/ingestion/webhook-token';
import {
  WEBHOOK_TOKEN_REPAIR_GRACE_MS,
  createWebhookToken,
  readWebhookToken,
  rotateWebhookToken,
} from '@/lib/ingestion/webhook-token-provisioning';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  type Tenant,
  cleanupDomains,
  cleanupTenants,
  closePg,
  createTenant,
  freshDomain,
  hasStack,
  pg,
  seedConnectedShop,
  service,
} from '../helpers/shopify-webhooks-1b';

const APP = 'wps1b-token-app-sentinel';
let tenant: Tenant;

async function rawRow(connectionId: string) {
  const { rows } = await (await pg()).query(
    `select public_id, secret_hash, previous_secret_hash, previous_secret_expires_at,
            rotated_at, revoked_at
       from public.store_connection_webhook_token where store_connection_id = $1`,
    [connectionId],
  );
  return rows[0] as
    | {
        public_id: string;
        secret_hash: string;
        previous_secret_hash: string | null;
        previous_secret_expires_at: Date | null;
        rotated_at: Date | null;
        revoked_at: Date | null;
      }
    | undefined;
}

async function readRow(connectionId: string) {
  const read = await readWebhookToken(service(), connectionId);
  if (!read.ok || !read.row) throw new Error('jeton illisible');
  return read.row;
}

beforeAll(async () => {
  if (!hasStack) return;
  tenant = await createTenant('wps1b-token');
}, 60_000);

afterEach(cleanupDomains);

afterAll(async () => {
  await closePg();
  await cleanupTenants();
});

describe('createWebhookToken', () => {
  it.skipIf(!hasStack)('crée une ligne dont seule l’empreinte du secret est stockée', async () => {
    const { connectionId } = await seedConnectedShop(tenant, freshDomain('create'), {
      clientId: APP,
    });

    const created = await createWebhookToken(service(), connectionId);

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const row = await rawRow(connectionId);
    expect(row?.public_id).toBe(created.token.publicId);
    expect(row?.secret_hash).toBe(hashWebhookTokenSecret(created.token.secret));
    expect(row?.secret_hash).not.toContain(created.token.secret);
    expect(row?.previous_secret_hash).toBeNull();
    expect(row?.revoked_at).toBeNull();
  });

  it.skipIf(!hasStack)('une seconde création rend conflict et n’écrase rien', async () => {
    const { connectionId } = await seedConnectedShop(tenant, freshDomain('create-twice'), {
      clientId: APP,
    });
    await createWebhookToken(service(), connectionId);
    const before = await rawRow(connectionId);

    expect(await createWebhookToken(service(), connectionId)).toEqual({
      ok: false,
      reason: 'conflict',
    });
    expect(await rawRow(connectionId)).toEqual(before);
  });
});

describe('rotateWebhookToken — deux modes nommés', () => {
  it.skipIf(!hasStack)(
    'installation : sans grâce — empreinte précédente et échéance à NULL, même public_id',
    async () => {
      const { connectionId } = await seedConnectedShop(tenant, freshDomain('rot-install'), {
        clientId: APP,
      });
      const created = await createWebhookToken(service(), connectionId);
      if (!created.ok) throw new Error('création');

      const rotated = await rotateWebhookToken(service(), {
        row: await readRow(connectionId),
        mode: 'installation',
      });

      expect(rotated.ok).toBe(true);
      if (!rotated.ok) return;
      expect(rotated.token.grace).toBe(false);
      const row = await rawRow(connectionId);
      expect(row?.public_id).toBe(created.token.publicId);
      expect(row?.secret_hash).toBe(hashWebhookTokenSecret(rotated.token.secret));
      expect(row?.previous_secret_hash).toBeNull();
      expect(row?.previous_secret_expires_at).toBeNull();
      // L'ancien secret n'est plus reconnu par aucune des deux empreintes.
      expect(verifyWebhookTokenSecret(created.token.secret, row?.secret_hash ?? '')).toBe(false);
    },
  );

  it.skipIf(!hasStack)(
    'réparation : avec grâce de 24 h — l’ancienne empreinte reste acceptée',
    async () => {
      const { connectionId } = await seedConnectedShop(tenant, freshDomain('rot-repair'), {
        clientId: APP,
      });
      const created = await createWebhookToken(service(), connectionId);
      if (!created.ok) throw new Error('création');
      const now = new Date();

      const rotated = await rotateWebhookToken(service(), {
        row: await readRow(connectionId),
        mode: 'repair',
        now,
      });

      expect(rotated.ok).toBe(true);
      if (!rotated.ok) return;
      expect(rotated.token.grace).toBe(true);
      const row = await rawRow(connectionId);
      expect(row?.previous_secret_hash).toBe(created.token.secretHash);
      expect(row?.previous_secret_expires_at?.getTime()).toBe(
        now.getTime() + WEBHOOK_TOKEN_REPAIR_GRACE_MS,
      );
    },
  );

  it.skipIf(!hasStack)(
    'réparation avec keepPreviousInGrace : l’empreinte encore en service reste en grâce, pas la courante inutilisée',
    async () => {
      const { connectionId } = await seedConnectedShop(tenant, freshDomain('rot-keep'), {
        clientId: APP,
      });
      const first = await createWebhookToken(service(), connectionId);
      if (!first.ok) throw new Error('création');
      // Première rotation de réparation, « interrompue » avant l'enregistrement chez Shopify.
      const interrupted = await rotateWebhookToken(service(), {
        row: await readRow(connectionId),
        mode: 'repair',
      });
      if (!interrupted.ok) throw new Error('rotation');

      const second = await rotateWebhookToken(service(), {
        row: await readRow(connectionId),
        mode: 'repair',
        keepPreviousInGrace: true,
      });

      expect(second.ok).toBe(true);
      const row = await rawRow(connectionId);
      // Contrôle positif : l'empreinte d'origine, seule encore enregistrée chez Shopify, survit.
      expect(row?.previous_secret_hash).toBe(first.token.secretHash);
      expect(row?.previous_secret_hash).not.toBe(interrupted.token.secretHash);
    },
  );

  it.skipIf(!hasStack)(
    'remet revoked_at à NULL explicitement, et ne garde jamais une empreinte révoquée en grâce',
    async () => {
      const { connectionId } = await seedConnectedShop(tenant, freshDomain('rot-revoked'), {
        clientId: APP,
      });
      await createWebhookToken(service(), connectionId);
      await (await pg()).query(
        'update public.store_connection_webhook_token set revoked_at = now() where store_connection_id = $1',
        [connectionId],
      );
      expect((await rawRow(connectionId))?.revoked_at).not.toBeNull();

      const rotated = await rotateWebhookToken(service(), {
        row: await readRow(connectionId),
        mode: 'repair',
      });

      expect(rotated.ok).toBe(true);
      const row = await rawRow(connectionId);
      expect(row?.revoked_at).toBeNull();
      expect(row?.previous_secret_hash).toBeNull();
      expect(row?.previous_secret_expires_at).toBeNull();
    },
  );
});

describe('rotateWebhookToken — compare-and-set sur l’empreinte lue', () => {
  it.skipIf(!hasStack)(
    'une rotation fondée sur une empreinte périmée rend conflict et n’écrit rien',
    async () => {
      const { connectionId } = await seedConnectedShop(tenant, freshDomain('rot-cas'), {
        clientId: APP,
      });
      await createWebhookToken(service(), connectionId);
      const staleRow = await readRow(connectionId);

      // Un autre détenteur tourne le jeton entre la lecture et l'écriture.
      const winner = await rotateWebhookToken(service(), { row: staleRow, mode: 'repair' });
      expect(winner.ok).toBe(true);
      const afterWinner = await rawRow(connectionId);

      const loser = await rotateWebhookToken(service(), { row: staleRow, mode: 'repair' });

      expect(loser).toEqual({ ok: false, reason: 'conflict' });
      expect(await rawRow(connectionId)).toEqual(afterWinner);
    },
  );

  it.skipIf(!hasStack)(
    'contrôle positif : fondée sur l’empreinte courante, la rotation aboutit',
    async () => {
      const { connectionId } = await seedConnectedShop(tenant, freshDomain('rot-cas-ok'), {
        clientId: APP,
      });
      await createWebhookToken(service(), connectionId);
      await rotateWebhookToken(service(), { row: await readRow(connectionId), mode: 'repair' });

      const next = await rotateWebhookToken(service(), {
        row: await readRow(connectionId),
        mode: 'repair',
      });

      expect(next.ok).toBe(true);
    },
  );

  it.skipIf(!hasStack)('deux rotations concurrentes : exactement une aboutit', async () => {
    for (let round = 0; round < 5; round += 1) {
      const { connectionId } = await seedConnectedShop(tenant, freshDomain(`rot-race-${round}`), {
        clientId: APP,
      });
      await createWebhookToken(service(), connectionId);
      const row = await readRow(connectionId);

      const results = await Promise.all([
        rotateWebhookToken(service(), { row, mode: 'repair' }),
        rotateWebhookToken(service(), { row, mode: 'repair' }),
      ]);

      expect(results.filter((result) => result.ok)).toHaveLength(1);
      const winner = results.find((result) => result.ok);
      if (winner?.ok) {
        expect((await rawRow(connectionId))?.secret_hash).toBe(winner.token.secretHash);
      }
    }
  });
});
