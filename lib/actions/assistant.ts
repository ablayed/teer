'use server';

import { authActionClient } from '@/lib/actions/safe-action';
import { createConversation } from '@/lib/ia/conversation';
import type { Database } from '@/lib/supabase/database.types';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

type Client = SupabaseClient<Database>;

export type IaConversationSummary = {
  id: string;
  title: string | null;
  updatedAt: string;
};

export type IaStoredMessage = {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  createdAt: string;
};

// Crée une conversation vide pour l'utilisateur courant ; la route /chat
// recevra ensuite cet id existant et possédé.
export const createConversationAction = authActionClient
  .metadata({ actionName: 'assistant.create_conversation', section: 'assistant' })
  .action(async ({ ctx }) => {
    const supabase = ctx.supabase as unknown as Client;
    const { data: member } = await supabase
      .from('merchant_member')
      .select('merchant_account_id')
      .eq('user_id', ctx.user.id)
      .limit(1)
      .maybeSingle();
    if (!member) {
      return { ok: false as const, errorCode: 'forbidden' as const };
    }
    const id = await createConversation(supabase, member.merchant_account_id, ctx.user.id);
    if (!id) {
      return { ok: false as const, errorCode: 'create_error' as const };
    }
    return { ok: true as const, conversationId: id };
  });

// Liste les conversations de l'utilisateur (RLS : ses propres conversations).
export const listConversationsAction = authActionClient
  .metadata({ actionName: 'assistant.list_conversations', section: 'assistant' })
  .action(async ({ ctx }) => {
    const supabase = ctx.supabase as unknown as Client;
    const { data, error } = await supabase
      .from('ia_conversation')
      .select('id, title, updated_at')
      .order('updated_at', { ascending: false })
      .limit(50);
    if (error) {
      return { ok: false as const, errorCode: 'data_error' as const };
    }
    const conversations: IaConversationSummary[] = (data ?? []).map((row) => ({
      id: row.id,
      title: row.title,
      updatedAt: row.updated_at,
    }));
    return { ok: true as const, conversations };
  });

// Charge les messages d'une conversation (RLS : seulement si possédée).
export const getConversationMessagesAction = authActionClient
  .metadata({ actionName: 'assistant.get_messages', section: 'assistant' })
  .inputSchema(z.object({ conversationId: z.string().uuid() }))
  .action(async ({ ctx, parsedInput }) => {
    const supabase = ctx.supabase as unknown as Client;
    const { data, error } = await supabase
      .from('ia_message')
      .select('id, role, content, created_at')
      .eq('conversation_id', parsedInput.conversationId)
      .order('created_at', { ascending: true });
    if (error) {
      return { ok: false as const, errorCode: 'data_error' as const };
    }
    const messages: IaStoredMessage[] = (data ?? [])
      .filter(
        (row): row is typeof row & { role: 'user' | 'assistant' | 'tool' } =>
          row.role === 'user' || row.role === 'assistant' || row.role === 'tool',
      )
      .map((row) => ({
        id: row.id,
        role: row.role,
        content: row.content,
        createdAt: row.created_at,
      }));
    return { ok: true as const, messages };
  });
