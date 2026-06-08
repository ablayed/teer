import type { Database } from '@/lib/supabase/database.types';
import type { SupabaseClient } from '@supabase/supabase-js';

type Client = SupabaseClient<Database>;

function deriveTitle(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed.length > 60 ? `${trimmed.slice(0, 57)}…` : trimmed || 'Nouvelle conversation';
}

// Crée une conversation vide (RLS : scopée tenant + user). Retourne son id,
// ou null en cas d'échec. Appelée par l'action serveur AVANT le chat, afin que
// la route reçoive toujours un id existant et possédé.
export async function createConversation(
  supabase: Client,
  merchantAccountId: string,
  userId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('ia_conversation')
    .insert({ merchant_account_id: merchantAccountId, user_id: userId })
    .select('id')
    .single();
  if (error || !data) {
    return null;
  }
  return data.id;
}

// Valide qu'une conversation existe et appartient à l'utilisateur (via RLS).
// Au passage, fixe le titre à partir du premier message s'il est encore vide.
// Retourne l'id validé, ou null si introuvable / non possédée.
export async function validateConversation(
  supabase: Client,
  conversationId: string,
  firstUserText: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('ia_conversation')
    .select('id, title')
    .eq('id', conversationId)
    .maybeSingle();
  if (error || !data) {
    return null;
  }
  if (!data.title) {
    await supabase
      .from('ia_conversation')
      .update({ title: deriveTitle(firstUserText) })
      .eq('id', conversationId);
  }
  return data.id;
}

export async function persistMessage(
  supabase: Client,
  merchantAccountId: string,
  conversationId: string,
  role: 'user' | 'assistant' | 'tool',
  content: string,
): Promise<void> {
  if (!content.trim()) {
    return;
  }
  await supabase.from('ia_message').insert({
    conversation_id: conversationId,
    merchant_account_id: merchantAccountId,
    role,
    content,
  });
}

// Bump updated_at (le trigger set_updated_at se déclenche sur UPDATE) pour faire
// remonter la conversation en tête de liste.
export async function touchConversation(supabase: Client, conversationId: string): Promise<void> {
  await supabase
    .from('ia_conversation')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', conversationId);
}
