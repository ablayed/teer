'use server';

import { authActionClient } from '@/lib/actions/safe-action';
import { writePcdAccessAuditCategories } from '@/lib/security/pcd-access-audit';
import { PcdAccessControlError, consumePcdQuota } from '@/lib/security/pcd-access-controls';
import type { Database } from '@/lib/supabase/database.types';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

const orderIdSchema = z.object({ orderId: z.string().uuid() });

export const recordWhatsappShareAction = authActionClient
  .metadata({ actionName: 'orders.external_share_whatsapp', section: 'orders' })
  .inputSchema(orderIdSchema)
  .action(async ({ ctx, parsedInput }) => {
    const supabase = ctx.supabase as unknown as SupabaseClient<Database>;
    const { data: order, error } = await supabase
      .from('orders')
      .select('id, merchant_account_id, shop_id')
      .eq('id', parsedInput.orderId)
      .maybeSingle();

    if (error || !order) {
      return { ok: false as const, errorCode: 'order_not_found' as const };
    }

    try {
      await consumePcdQuota(supabase, {
        action: 'external_share',
        actorKind: 'human',
        shopId: order.shop_id,
        tenantId: order.merchant_account_id,
      });
      await writePcdAccessAuditCategories(
        supabase,
        {
          tenantId: order.merchant_account_id,
          shopId: order.shop_id,
          actorKind: 'human',
          action: 'external_share',
          purpose: 'external_share',
          outcome: 'allowed',
          resourceType: 'whatsapp_share',
          resourceId: order.id,
          surface: 'whatsapp',
          metadata: { channel: 'whatsapp' },
        },
        ['customer_contact', 'delivery_address'],
      );
    } catch (error) {
      if (error instanceof PcdAccessControlError && error.code === 'quota_exceeded') {
        return { ok: false as const, errorCode: 'rate_limited' as const };
      }
      if (error instanceof PcdAccessControlError && error.code === 'quota_unavailable') {
        return { ok: false as const, errorCode: 'quota_unavailable' as const };
      }
      return { ok: false as const, errorCode: 'audit_unavailable' as const };
    }

    return { ok: true as const };
  });
