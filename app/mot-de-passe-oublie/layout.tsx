import { NextIntlClientProvider } from 'next-intl';
import { getMessages } from 'next-intl/server';
import type { ReactNode } from 'react';

// Provider i18n client pour /mot-de-passe-oublie et /mot-de-passe-oublie/nouveau
// (les deux formulaires sont des Client Components qui utilisent useTranslations).
// Même motif que /connexion : scopé au segment, jamais au root, qui reste 100 %
// Server Component pour ne rien imposer à la landing.
export default async function MotDePasseOublieLayout({ children }: { children: ReactNode }) {
  const messages = await getMessages();
  return <NextIntlClientProvider messages={messages}>{children}</NextIntlClientProvider>;
}
