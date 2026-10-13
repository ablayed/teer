import {
  WebhookProcessingError,
  controlledPart,
  describeErrorOrigin,
  durableErrorCode,
} from '@/lib/shopify/webhook-error-origin';
import { describe, expect, it } from 'vitest';

// Le code durable d'un événement passe par `finish_shopify_webhook_event`, qui le refuse hors de
// cette forme.
const DURABLE = /^[a-z0-9_]{1,64}$/;

describe("origine d'une erreur de traitement de webhook", () => {
  it("garde le code et la contrainte d'une erreur Postgres, jamais son texte", () => {
    const origin = describeErrorOrigin({
      code: '23505',
      details: 'Key (shop_id, shopify_order_id)=(a1, 4242) already exists.',
      hint: null,
      message:
        'duplicate key value violates unique constraint "orders_shop_shopify_order_unique_idx"',
    });

    expect(origin).toEqual({
      code: '23505',
      constraint: 'orders_shop_shopify_order_unique_idx',
      kind: 'database',
    });
    expect(JSON.stringify(origin)).not.toContain('4242');
  });

  it('remonte la chaîne de causes', () => {
    const wrapped = new Error('pcd_access_audit_write_failed', {
      cause: { code: 'PGRST301', message: 'JWT expired' },
    });
    expect(describeErrorOrigin(wrapped)).toMatchObject({ code: 'PGRST301', kind: 'database' });
  });

  it('reconnaît un statut HTTP, une panne réseau, et ne devine rien d’autre', () => {
    expect(describeErrorOrigin({ message: 'upstream', status: 502 })).toEqual({
      code: '502',
      constraint: null,
      kind: 'http',
    });
    expect(describeErrorOrigin(new TypeError('fetch failed'))).toMatchObject({ kind: 'network' });
    expect(describeErrorOrigin(new Error('+221770000111 introuvable'))).toEqual({
      code: null,
      constraint: null,
      kind: 'unknown',
    });
    expect(describeErrorOrigin(undefined).kind).toBe('unknown');
  });

  it('écarte un code qui n’en a pas la forme', () => {
    expect(describeErrorOrigin({ code: 'client +221 77', message: 'x' }).code).toBeNull();
    expect(describeErrorOrigin({ code: 23505, message: 'x' }).code).toBeNull();
  });

  it('compose un code durable accepté par la base', () => {
    const known = durableErrorCode('shopify_order_persist_failed', {
      code: '23505',
      constraint: null,
      kind: 'database',
    });
    expect(known).toBe('shopify_order_persist_failed__23505');
    expect(controlledPart(known)).toBe('shopify_order_persist_failed');

    const cases = [
      known,
      durableErrorCode('shopify_pcd_audit_failed', {
        code: 'PGRST301',
        constraint: null,
        kind: 'database',
      }),
      durableErrorCode('shopify_pcd_audit_failed', {
        code: null,
        constraint: null,
        kind: 'network',
      }),
      durableErrorCode('x'.repeat(60), { code: '23505', constraint: null, kind: 'database' }),
    ];
    for (const code of cases) expect(code).toMatch(DURABLE);
  });

  it('sans origine connue, le code contrôlé reste tel quel', () => {
    expect(durableErrorCode('gdpr_audit_failed', null)).toBe('gdpr_audit_failed');
    expect(
      durableErrorCode('gdpr_audit_failed', { code: null, constraint: null, kind: 'unknown' }),
    ).toBe('gdpr_audit_failed');
  });

  it('WebhookProcessingError : message contrôlé, origine gardée, cause conservée', () => {
    const cause = { code: '08006', message: 'connection failure' };
    const error = new WebhookProcessingError('shopify_pcd_audit_failed', cause);

    expect(error.message).toBe('shopify_pcd_audit_failed');
    expect(error.cause).toBe(cause);
    expect(error.origin).toMatchObject({ code: '08006', kind: 'database' });
  });

  it('WebhookProcessingError accepte une empreinte déjà relevée, contrainte comprise', () => {
    const origin = {
      code: '23505',
      constraint: 'customer_shopify_customer_unique_idx',
      kind: 'database',
    } as const;
    expect(new WebhookProcessingError('shopify_order_persist_failed', origin).origin).toEqual(
      origin,
    );
  });
});

describe('origine connue d’un échec de traitement', () => {
  it('lit la cause d’une erreur ordinaire, et rend null quand rien n’est connu', async () => {
    const { knownErrorOrigin } = await import('@/lib/shopify/webhook-error-origin');

    expect(
      knownErrorOrigin(
        new Error('gdpr_redaction_failed', { cause: { code: '40001', message: 'x' } }),
      ),
    ).toMatchObject({ code: '40001', kind: 'database' });
    expect(
      knownErrorOrigin(
        new WebhookProcessingError('gdpr_audit_failed', { code: '08006', message: 'x' }),
      ),
    ).toMatchObject({ code: '08006' });

    // Un refus métier n'a pas d'origine : son code durable reste le code contrôlé.
    expect(knownErrorOrigin(new Error('gdpr_shop_not_found'))).toBeNull();
    expect(
      knownErrorOrigin(new WebhookProcessingError('shopify_order_persist_failed', undefined)),
    ).toBeNull();
    expect(knownErrorOrigin('texte')).toBeNull();
  });
});

describe('écriture coupée avant la base', () => {
  it('une réponse de passerelle n’a pas de code : son statut HTTP la désigne', async () => {
    const { errorWithStatus, describeErrorOrigin, durableErrorCode } = await import(
      '@/lib/shopify/webhook-error-origin'
    );
    const gateway = errorWithStatus(
      { message: 'An invalid response was received from the upstream server' },
      502,
    );

    expect(describeErrorOrigin(gateway)).toEqual({ code: '502', constraint: null, kind: 'http' });
    expect(durableErrorCode('gdpr_audit_failed', describeErrorOrigin(gateway))).toBe(
      'gdpr_audit_failed__502',
    );
  });

  it('un code SQL prime sur le statut ; sans réponse du tout, c’est une panne réseau', async () => {
    const { errorWithStatus, describeErrorOrigin } = await import(
      '@/lib/shopify/webhook-error-origin'
    );

    expect(
      describeErrorOrigin(errorWithStatus({ code: '23505', message: 'duplicate key' }, 409)),
    ).toMatchObject({ code: '23505', kind: 'database' });
    expect(
      describeErrorOrigin(errorWithStatus({ code: '', message: 'TypeError: fetch failed' }, 0)),
    ).toEqual({ code: null, constraint: null, kind: 'network' });
    expect(errorWithStatus(null, 502)).toBeNull();
  });
});
