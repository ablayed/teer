---
name: teer-migration
description: >
  Use whenever writing or modifying a Supabase migration for Tëër — adding columns,
  creating tables, modifying RLS policies, backfilling data, or any schema change.
  Trigger proactively at the first mention of a migration, schema change, or new column.
---

## The non-negotiable STOP rule

Write the migration SQL file. Then stop immediately.

Do NOT run supabase db push or any command that applies the migration. The handoff is:
1. Write supabase/migrations/<timestamp>_<slug>.sql
2. Tell Ablaye: "Migration written. Run pnpm exec supabase db push then pnpm db:types, confirm success, then tell me."
3. Wait for confirmation before continuing with any implementation.

## New columns — always nullable first

Correct:
  ALTER TABLE orders ADD COLUMN order_state text;
  ALTER TABLE orders ADD COLUMN call_state text;

Wrong (causes silent transition failures on existing rows):
  ALTER TABLE orders ADD COLUMN order_state text NOT NULL DEFAULT 'open';

Add NOT NULL only in a later migration after backfill is verified.

## New tables — ENABLE + FORCE + explicit policies for all four operations

  ALTER TABLE stock_movement ENABLE ROW LEVEL SECURITY;
  ALTER TABLE stock_movement FORCE ROW LEVEL SECURITY;

  CREATE POLICY "tenant_select" ON stock_movement FOR SELECT
    USING (merchant_account_id = (
      SELECT merchant_account_id FROM merchant_member WHERE user_id = auth.uid()
    ));

  CREATE POLICY "tenant_insert" ON stock_movement FOR INSERT
    WITH CHECK (merchant_account_id = (
      SELECT merchant_account_id FROM merchant_member WHERE user_id = auth.uid()
    ));

No policy = zero access. Always write all four operations explicitly.

## UPDATE policies — always WITH CHECK

Correct:
  CREATE POLICY "tenant_update" ON orders FOR UPDATE
    USING (merchant_account_id = (...))
    WITH CHECK (merchant_account_id = (...));

Wrong (missing WITH CHECK silently rejects writes):
  CREATE POLICY "tenant_update" ON orders FOR UPDATE
    USING (merchant_account_id = (...));

## Gotchas

- COD status field is cod_status (text), NOT status. New 4-dimension columns: order_state, call_state, delivery_state, cash_state.
- Money columns are bigint minor units (FCFA, 0 decimals): cash_collectable_minor bigint.
- pnpm db:types must run after every push — stale types break server action validation silently.
- ENABLE RLS without policies = full lockout of all rows. Always write policies.
- Never write directly to order_state, call_state, delivery_state, or cash_state except in the initial backfill migration. All subsequent writes go through performTransition / transition_order RPC.
- The state machine, transition catalog, RPC, and RLS must change together — a schema change touching order state columns likely needs RPC + TypeScript updates too.
