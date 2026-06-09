import { NextIntlClientProvider } from 'next-intl';
import { getMessages } from 'next-intl/server';
import type { ReactNode } from 'react';

// Provider i18n client pour /onboarding (onboarding-flow est un Client Component
// qui utilise useTranslations). Scopé ici pour ne pas l'imposer à la landing.
export default async function OnboardingLayout({ children }: { children: ReactNode }) {
  const messages = await getMessages();
  return <NextIntlClientProvider messages={messages}>{children}</NextIntlClientProvider>;
}
