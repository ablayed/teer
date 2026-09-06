// Migration 0136 a déplacé le cœur `post_stock_movement` (12 arguments) dans le schéma
// `private`, non exposé par PostgREST — un test ne peut donc plus l'atteindre en HTTP,
// ni via un client `authenticated` (`ownerClient.rpc(...)`) ni via `service_role`
// (`admin.rpc(...)`) : l'exposition de schéma est une barrière au niveau du cache
// PostgREST, orthogonale au rôle. Ce helper appelle le cœur par une connexion Postgres
// directe, seule voie encore possible pour un seed de test — jamais via la surcharge
// publique à 13 arguments, qui n'accepte qu'un sous-ensemble des movement_type
// (`purchase_in`, `manual_adjustment`, `courier_return`, `driver_stock_set`) et ne
// couvre donc pas les seeds qui posent `dispatch`/`reserve`/`release`/`sold`/etc.
//
// Le guard interne du cœur (`coalesce(auth.role(), '') <> 'service_role' and
// current_member_role(p_merchant_account_id) is null`) résout `current_member_role` via
// `auth.uid()`, lui-même lu depuis la GUC de session `request.jwt.claim.sub`. Une
// connexion `pg` brute ne porte aucun JWT : sans `set_config`, `auth.uid()` est NULL,
// `current_member_role` ne trouve aucun membre, et le cœur lève `forbidden`. On simule
// donc explicitement l'identité de l'acteur avant l'appel — c'est le même motif que
// `tests/rls/customer-reliability-projection.rls.test.ts` (0132) pour ses deux
// connexions `pg` explicites.
//
// Le rôle Postgres réel de cette connexion (`postgres`, superuser/`rolbypassrls`) n'a
// aucune incidence ici : le guard du cœur ne teste jamais `current_setting('role')`,
// seulement `auth.role()`/`current_member_role`, tous deux dérivés du JWT simulé.

import { createTestPostgresClient } from './postgres-client';

const dbUrl =
  process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

export type StockMovementEngineArgs = {
  p_merchant_account_id: string;
  p_product_id: string;
  p_movement_type: string;
  p_qty: number;
  p_idempotency_key: string;
  p_created_by: string;
  p_order_id?: string;
  p_transition_id?: string;
  p_unit_cost?: number;
  p_received_value?: number;
  p_reason?: string;
  p_driver_id?: string | null;
};

export type StockMovementEngineResult = {
  data: string | null;
  error: { message: string } | null;
};

// `p_created_by` est systématiquement l'acteur réel de chaque appelant existant (le
// propriétaire signé qui invoquait auparavant `ownerClient.rpc(...)`) — on le réutilise
// comme sujet du JWT simulé, sans paramètre supplémentaire à threader dans les ~20
// sites d'appel convertis.
export async function callStockMovementEngine(
  args: StockMovementEngineArgs,
): Promise<StockMovementEngineResult> {
  const pg = createTestPostgresClient(dbUrl);
  await pg.connect();
  try {
    await pg.query(`select set_config('request.jwt.claim.sub', $1, false)`, [args.p_created_by]);
    await pg.query(`select set_config('request.jwt.claim.role', 'authenticated', false)`);

    const { rows } = await pg.query(
      `select private.post_stock_movement(
         p_merchant_account_id => $1,
         p_product_id          => $2,
         p_movement_type       => $3,
         p_qty                 => $4,
         p_idempotency_key     => $5,
         p_created_by          => $6,
         p_order_id            => $7,
         p_transition_id       => $8,
         p_unit_cost           => $9,
         p_received_value      => $10,
         p_reason              => $11,
         p_driver_id           => $12
       ) as id`,
      [
        args.p_merchant_account_id,
        args.p_product_id,
        args.p_movement_type,
        args.p_qty,
        args.p_idempotency_key,
        args.p_created_by,
        args.p_order_id ?? null,
        args.p_transition_id ?? null,
        args.p_unit_cost ?? null,
        args.p_received_value ?? null,
        args.p_reason ?? null,
        args.p_driver_id ?? null,
      ],
    );
    return { data: rows[0]?.id ?? null, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { data: null, error: { message } };
  } finally {
    await pg.end();
  }
}
