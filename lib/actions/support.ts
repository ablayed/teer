'use server';

import { authActionClient } from '@/lib/actions/safe-action';
import type { Database } from '@/lib/supabase/database.types';
import type { SupabaseClient } from '@supabase/supabase-js';

type SupabaseServerClient = SupabaseClient<Database>;

export type ActivationStep = {
  id: string;
  completed: boolean;
  href: string;
};

export type ActivationChecklist = {
  merchantAccountId: string;
  steps: ActivationStep[];
  allCompleted: boolean;
};

export const getActivationChecklistAction = authActionClient
  .metadata({ actionName: 'support.get_activation_checklist', section: 'support' })
  .action(async ({ ctx }) => {
    const supabase = ctx.supabase as unknown as SupabaseServerClient;
    const { data: member } = await supabase
      .from('merchant_member')
      .select('merchant_account_id, role')
      .eq('user_id', ctx.user.id)
      .limit(1)
      .maybeSingle();

    if (!member || (member.role !== 'owner' && member.role !== 'manager')) {
      return { ok: false as const, errorCode: 'forbidden' as const };
    }

    const mid = member.merchant_account_id;

    const [merchantRes, shopsRes, ordersRes, deliveredRes, collectedRes] = await Promise.all([
      supabase.from('merchant_account').select('onboarded_at').eq('id', mid).limit(1).maybeSingle(),
      supabase
        .from('shop')
        .select('id', { count: 'exact', head: true })
        .eq('merchant_account_id', mid),
      supabase
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .eq('merchant_account_id', mid),
      supabase
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .eq('merchant_account_id', mid)
        .eq('delivery_state', 'delivered'),
      supabase
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .eq('merchant_account_id', mid)
        .eq('cash_state', 'collected'),
    ]);

    const steps: ActivationStep[] = [
      {
        id: 'onboarded',
        completed: Boolean(merchantRes.data?.onboarded_at),
        href: '/onboarding',
      },
      {
        id: 'shopify',
        completed: (shopsRes.count ?? 0) > 0,
        href: '/boutiques',
      },
      {
        id: 'first-order',
        completed: (ordersRes.count ?? 0) > 0,
        href: '/commandes',
      },
      {
        id: 'first-delivery',
        completed: (deliveredRes.count ?? 0) > 0,
        href: '/commandes',
      },
      {
        id: 'first-cash',
        completed: (collectedRes.count ?? 0) > 0,
        href: '/livreurs',
      },
    ];

    return {
      ok: true as const,
      checklist: {
        merchantAccountId: mid,
        steps,
        allCompleted: steps.every((s) => s.completed),
      } satisfies ActivationChecklist,
    };
  });
