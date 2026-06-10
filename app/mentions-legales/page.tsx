import { LegalPage } from '@/components/legal/legal-page';
import { getLegalDocument } from '@/lib/legal/documents';
import type { Metadata } from 'next';

export const dynamic = 'force-static';

export async function generateMetadata(): Promise<Metadata> {
  const document = await getLegalDocument('mentions');

  return {
    title: `${document.title} | Tëër`,
    description: document.description,
    alternates: { canonical: document.route },
    robots: { index: true, follow: true },
  };
}

export default function MentionsLegalesPage() {
  return <LegalPage type="mentions" />;
}
