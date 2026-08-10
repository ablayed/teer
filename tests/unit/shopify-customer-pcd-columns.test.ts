// Bridge S3-A3 (0120) — prouve que getCustomerPcdColumnsAvailable détecte EXACTEMENT
// l'incompatibilité de schéma attendue (colonne absente) et relance toute autre erreur SQL,
// sans jamais deviner la disponibilité par défaut.
import { getCustomerPcdColumnsAvailable } from '@/lib/shopify/customer-pcd-columns';
import { describe, expect, it } from 'vitest';

type FakeError = { code: string; message: string } | null;

function makeFakeAdminClient(error: FakeError) {
  return {
    from(_table: string) {
      return {
        select(_columns: string) {
          return {
            limit(_n: number) {
              return Promise.resolve({ data: error ? null : [], error });
            },
          };
        },
      };
    },
  } as unknown as Parameters<typeof getCustomerPcdColumnsAvailable>[0];
}

describe('getCustomerPcdColumnsAvailable', () => {
  it('renvoie true quand le select réussit (schéma avant 0120)', async () => {
    const admin = makeFakeAdminClient(null);
    await expect(getCustomerPcdColumnsAvailable(admin)).resolves.toBe(true);
  });

  it('renvoie false sur 42703 (column does not exist — schéma après 0120)', async () => {
    const admin = makeFakeAdminClient({ code: '42703', message: 'column "tags" does not exist' });
    await expect(getCustomerPcdColumnsAvailable(admin)).resolves.toBe(false);
  });

  it('renvoie false sur PGRST204 (colonne absente du schema cache PostgREST)', async () => {
    const admin = makeFakeAdminClient({
      code: 'PGRST204',
      message: "Could not find the 'tags' column of 'customer' in the schema cache",
    });
    await expect(getCustomerPcdColumnsAvailable(admin)).resolves.toBe(false);
  });

  it('relance toute autre erreur SQL (jamais interprétée comme une incompatibilité 0120)', async () => {
    const admin = makeFakeAdminClient({ code: '42501', message: 'permission denied' });
    await expect(getCustomerPcdColumnsAvailable(admin)).rejects.toMatchObject({ code: '42501' });
  });

  it('met en cache le résultat par instance de client (un seul appel réseau)', async () => {
    let calls = 0;
    const admin = {
      from(_table: string) {
        return {
          select(_columns: string) {
            return {
              limit(_n: number) {
                calls += 1;
                return Promise.resolve({ data: [], error: null });
              },
            };
          },
        };
      },
    } as unknown as Parameters<typeof getCustomerPcdColumnsAvailable>[0];

    await getCustomerPcdColumnsAvailable(admin);
    await getCustomerPcdColumnsAvailable(admin);

    expect(calls).toBe(1);
  });
});
