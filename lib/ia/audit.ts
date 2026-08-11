import type { IaToolContext } from '@/lib/ia/types';
import { type PcdAccessCategory, writePcdAccessAudit } from '@/lib/security/pcd-access-audit';

// Journalise un appel d'outil dans ia_tool_audit via la RPC SECURITY DEFINER
// (qui valide l'appartenance au tenant et journalise même les refus).
// Best-effort : un échec d'écriture ne doit JAMAIS casser le flux de chat.
export async function logToolAudit(
  ctx: IaToolContext,
  entry: {
    toolName: string;
    allowed: boolean;
    deniedReason?: string | null;
    latencyMs?: number | null;
    dataCategory?: PcdAccessCategory;
  },
): Promise<void> {
  const dataCategory =
    entry.dataCategory ??
    (entry.toolName === 'get_customer_reliability' ? 'customer_identity' : 'merchant_data');

  try {
    await ctx.supabase.rpc('log_ia_tool_audit', {
      p_merchant_account_id: ctx.merchantAccountId,
      p_user_role: ctx.role,
      p_tool_name: entry.toolName,
      p_tool_args: {},
      p_allowed: entry.allowed,
      p_conversation_id: ctx.conversationId ?? undefined,
      p_denied_reason: entry.deniedReason ?? undefined,
      p_latency_ms: entry.latencyMs ?? undefined,
      p_data_category: dataCategory,
    });
  } catch {
    // Silencieux : l'audit ne doit pas interrompre la conversation.
  }

  try {
    await writePcdAccessAudit(ctx.supabase, {
      tenantId: ctx.merchantAccountId,
      actorKind: 'human',
      action: 'ai_processing',
      dataCategory,
      purpose: 'customer_support',
      outcome: entry.allowed ? (entry.deniedReason ? 'failed' : 'succeeded') : 'denied',
      resourceType: 'assistant',
      resourceId: ctx.conversationId ?? null,
      surface: 'assistant',
      metadata: {
        ...(entry.latencyMs != null ? { latency_ms: entry.latencyMs } : {}),
        ...(entry.deniedReason ? { error_code: entry.deniedReason } : {}),
      },
    });
  } catch {
    // IA reste best-effort pour cette fondation ; les exports sensibles sont
    // eux explicitement fail-closed par leurs appelants.
  }
}
