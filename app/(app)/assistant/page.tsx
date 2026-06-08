import { AssistantView } from '@/components/assistant/assistant-view';
import type { IaConversationSummary } from '@/lib/actions/assistant';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { type TeamRole, isTeamRole } from '@/lib/team/permissions';
import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';

export default async function AssistantPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect('/connexion');
  }

  const t = await getTranslations('assistant');

  const { data: memberRaw } = await supabase
    .from('merchant_member')
    .select('role')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle();
  const member = memberRaw as { role: string } | null;
  const role: TeamRole = member && isTeamRole(member.role) ? member.role : 'agent';

  const { data: conversationRaw } = await supabase
    .from('ia_conversation')
    .select('id, title, updated_at')
    .order('updated_at', { ascending: false })
    .limit(50);
  const conversationRows = (conversationRaw ?? []) as {
    id: string;
    title: string | null;
    updated_at: string;
  }[];
  const initialConversations: IaConversationSummary[] = conversationRows.map((row) => ({
    id: row.id,
    title: row.title,
    updatedAt: row.updated_at,
  }));

  return (
    <main className="space-y-6" id="main">
      <header className="space-y-2">
        <h1 className="font-display text-4xl md:text-5xl">{t('title')}</h1>
        <p className="text-muted">{t('subtitle')}</p>
      </header>
      <AssistantView initialConversations={initialConversations} role={role} />
    </main>
  );
}
