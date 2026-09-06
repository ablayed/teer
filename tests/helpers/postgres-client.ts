import { assertPostgresTarget } from '@/lib/security/supabase-target-policy';
import { Client } from 'pg';

export type TestPostgresClient = Client;

type TestPostgresClientOptions = Readonly<{
  connectionTimeoutMillis?: number;
}>;

/**
 * Construit le seul client PostgreSQL admis dans les tests.
 *
 * Les options exposees ne contiennent aucun champ de cible. La chaine controlee est
 * posee directement dans la configuration finalement remise a `pg` : un appelant ne
 * peut donc pas la remplacer par un hote, un port ou une autre connectionString.
 */
export function createTestPostgresClient(
  target: string,
  variableName = 'SUPABASE_DB_URL',
  options: TestPostgresClientOptions = {},
): TestPostgresClient {
  assertPostgresTarget({ target, variableName });

  return new Client({
    connectionTimeoutMillis: options.connectionTimeoutMillis,
    connectionString: target,
  });
}
