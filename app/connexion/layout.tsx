import { NextIntlClientProvider } from 'next-intl';
import { getMessages } from 'next-intl/server';
import type { ReactNode } from 'react';

// Provider i18n client pour /connexion (le formulaire est un Client Component
// qui utilise useTranslations). Scopé ici plutôt qu'au root pour ne pas
// l'imposer à la landing.
export default async function ConnexionLayout({ children }: { children: ReactNode }) {
  const messages = await getMessages();
  return <NextIntlClientProvider messages={messages}>{children}</NextIntlClientProvider>;
}
