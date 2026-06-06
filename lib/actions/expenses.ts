'use server';

import { requireRole } from '@/lib/actions/safe-action';
import { env } from '@/lib/env';
import type { Database } from '@/lib/supabase/database.types';
import { createClient } from '@supabase/supabase-js';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

function createAdmin() {
  return createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

const expensePayloadSchema = z.object({
  categoryId: z.string().uuid(),
  freeTextCategory: z.string().max(100).nullish(),
  amountMinor: z.number().int().positive(),
  spentAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  note: z.string().max(500).nullish(),
});

export const listExpenseCategoriesAction = requireRole('owner')
  .metadata({ actionName: 'expenses.categories.list', section: 'finance' })
  .inputSchema(z.object({}))
  .action(async ({ ctx }) => {
    const admin = createAdmin();
    const { data, error } = await admin
      .from('expense_category')
      .select('id, code, label_fr, syscohada_account, is_system, sort_order')
      .eq('merchant_account_id', ctx.member.merchantAccountId)
      .eq('is_active', true)
      .order('sort_order');
    if (error) return { ok: false as const, errorCode: 'fetch_error' as const };
    return { ok: true as const, categories: data ?? [] };
  });

export const listExpensesAction = requireRole('owner')
  .metadata({ actionName: 'expenses.list', section: 'finance' })
  .inputSchema(z.object({ from: z.string(), to: z.string() }))
  .action(async ({ ctx, parsedInput }) => {
    const admin = createAdmin();
    const { from, to } = parsedInput;
    const { data, error } = await admin
      .from('expense')
      .select('id, amount_minor, category_id, free_text_category, note, spent_at, created_at')
      .eq('merchant_account_id', ctx.member.merchantAccountId)
      .gte('spent_at', from)
      .lte('spent_at', to)
      .order('spent_at', { ascending: false });
    if (error) return { ok: false as const, errorCode: 'fetch_error' as const };
    return { ok: true as const, expenses: data ?? [] };
  });

export const createExpenseAction = requireRole('owner')
  .metadata({ actionName: 'expenses.create', section: 'finance' })
  .inputSchema(expensePayloadSchema)
  .action(async ({ ctx, parsedInput }) => {
    const admin = createAdmin();
    const { data, error } = await admin
      .from('expense')
      .insert({
        merchant_account_id: ctx.member.merchantAccountId,
        category_id: parsedInput.categoryId,
        free_text_category: parsedInput.freeTextCategory ?? null,
        amount_minor: parsedInput.amountMinor,
        spent_at: parsedInput.spentAt,
        note: parsedInput.note ?? null,
        created_by: ctx.user.id,
      })
      .select('id')
      .single();
    if (error || !data) return { ok: false as const, errorCode: 'create_error' as const };
    revalidatePath('/finances');
    return { ok: true as const, id: data.id };
  });

export const updateExpenseAction = requireRole('owner')
  .metadata({ actionName: 'expenses.update', section: 'finance' })
  .inputSchema(expensePayloadSchema.extend({ id: z.string().uuid() }))
  .action(async ({ ctx, parsedInput }) => {
    const admin = createAdmin();
    const { error } = await admin
      .from('expense')
      .update({
        category_id: parsedInput.categoryId,
        free_text_category: parsedInput.freeTextCategory ?? null,
        amount_minor: parsedInput.amountMinor,
        spent_at: parsedInput.spentAt,
        note: parsedInput.note ?? null,
      })
      .eq('id', parsedInput.id)
      .eq('merchant_account_id', ctx.member.merchantAccountId);
    if (error) return { ok: false as const, errorCode: 'update_error' as const };
    revalidatePath('/finances');
    return { ok: true as const };
  });

export const deleteExpenseAction = requireRole('owner')
  .metadata({ actionName: 'expenses.delete', section: 'finance' })
  .inputSchema(z.object({ id: z.string().uuid() }))
  .action(async ({ ctx, parsedInput }) => {
    const admin = createAdmin();
    const { error } = await admin
      .from('expense')
      .delete()
      .eq('id', parsedInput.id)
      .eq('merchant_account_id', ctx.member.merchantAccountId);
    if (error) return { ok: false as const, errorCode: 'delete_error' as const };
    revalidatePath('/finances');
    return { ok: true as const };
  });
