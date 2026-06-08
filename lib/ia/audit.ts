import type { IaToolContext } from '@/lib/ia/types';
import type { Json } from '@/lib/supabase/database.types';

// Journalise un appel d'outil dans ia_tool_audit via la RPC SECURITY DEFINER
// (qui valide l'appartenance au tenant et journalise même les refus).
// Best-effort : un échec d'écriture ne doit JAMAIS casser le flux de chat.
export async function logToolAudit(
  ctx: IaToolContext,
  entry: {
    toolName: string;
    toolArgs: unknown;
    allowed: boolean;
    deniedReason?: string | null;
    latencyMs?: number | null;
  },
): Promise<void> {
  try {
    await ctx.supabase.rpc('log_ia_tool_audit', {
      p_merchant_account_id: ctx.merchantAccountId,
      p_user_role: ctx.role,
      p_tool_name: entry.toolName,
      p_tool_args: (entry.toolArgs ?? {}) as Json,
      p_allowed: entry.allowed,
      p_conversation_id: ctx.conversationId ?? undefined,
      p_denied_reason: entry.deniedReason ?? undefined,
      p_latency_ms: entry.latencyMs ?? undefined,
    });
  } catch {
    // Silencieux : l'audit ne doit pas interrompre la conversation.
  }
}
