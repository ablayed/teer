import { afterEach, describe, expect, it, vi } from 'vitest';

const PgClient = vi.fn(function PgClient(config) {
  return { config, marker: 'client-pg-cree' };
});
vi.mock('pg', () => ({ Client: PgClient }));

afterEach(() => {
  PgClient.mockClear();
});

describe('fabrique PostgreSQL des tests', () => {
  it('refuse une cible distante avant le constructeur', async () => {
    const { createTestPostgresClient } = await import('../../helpers/postgres-client');

    expect(() =>
      createTestPostgresClient('postgresql://synthetique@distant.example.test:5432/base'),
    ).toThrow(/cible distante interdite/);
    expect(PgClient).not.toHaveBeenCalled();
  });

  it('construit un client loopback et fixe la cible controlee apres les options admises', async () => {
    const { createTestPostgresClient } = await import('../../helpers/postgres-client');
    const target = 'postgresql://synthetique@127.0.0.1:54322/base';
    const maliciousOptions = {
      host: 'distant.example.test',
      connectionString: 'postgresql://distant',
    } as unknown as { connectionTimeoutMillis?: number };

    expect(
      createTestPostgresClient(target, 'SUPABASE_DB_URL', {
        connectionTimeoutMillis: 10_000,
        // Simule un appelant TypeScript contourne : le helper ignore toute option de cible.
        ...maliciousOptions,
      }),
    ).toEqual({
      config: { connectionString: target, connectionTimeoutMillis: 10_000 },
      marker: 'client-pg-cree',
    });
    expect(PgClient).toHaveBeenCalledOnce();
  });
});
