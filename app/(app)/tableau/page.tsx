import { createSupabaseServerClient } from '@/lib/supabase/server';
import messages from '@/messages/fr.json';

export default async function TableauPage() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const name = user?.email?.split('@')[0] ?? '';

  return (
    <section className="space-y-4">
      <h1 className="font-display text-4xl md:text-5xl">
        {messages.app.greeting.replace('{name}', name)}
      </h1>
      <p className="text-muted">{messages.app.phase0_placeholder}</p>
    </section>
  );
}
