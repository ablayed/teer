import { NextIntlClientProvider } from 'next-intl';
import { getMessages } from 'next-intl/server';
import type { ReactNode } from 'react';

// Provider i18n client pour /invitation/* : InvitationChooser est un Client
// Component qui utilise useTranslations('invitation'). Scopé ici plutôt qu'au
// root, sur le même modèle que app/connexion/layout.tsx.
export default async function InvitationLayout({ children }: { children: ReactNode }) {
  const messages = await getMessages();
  return <NextIntlClientProvider messages={messages}>{children}</NextIntlClientProvider>;
}
