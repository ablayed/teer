import { Wordmark } from '@/components/wordmark';
import { Mail, MessageCircle, Phone } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';

// Footer minimal. Contact e-mail réel ; WhatsApp / téléphone rendus uniquement si
// renseignés dans messages/fr.json (on n'invente aucun numéro).
export async function MarketingFooter() {
  const t = await getTranslations('marketing.footer');
  const whatsapp = t('whatsappNumber').trim();
  const phone = t('phoneNumber').trim();

  return (
    <footer className="border-border border-t bg-sunken/40">
      <div className="mx-auto flex max-w-6xl flex-col gap-10 px-5 py-12 md:flex-row md:items-start md:justify-between">
        <div className="max-w-sm">
          <Wordmark size="md" />
          <p className="mt-3 text-[14px] text-muted leading-6">{t('tagline')}</p>
        </div>

        <div className="text-[14px]">
          <p className="mb-3 font-medium text-text">{t('contactTitle')}</p>
          <ul className="flex flex-col gap-2.5 text-muted">
            <li>
              <a
                href={`mailto:${t('email')}`}
                className="inline-flex items-center gap-2 transition-colors hover:text-accent-deep"
              >
                <Mail className="h-4 w-4" aria-hidden="true" />
                {t('email')}
              </a>
            </li>
            {whatsapp.length > 0 && (
              <li>
                <a
                  href={`https://wa.me/${whatsapp.replace(/[^0-9]/g, '')}`}
                  className="inline-flex items-center gap-2 transition-colors hover:text-accent-deep"
                >
                  <MessageCircle className="h-4 w-4" aria-hidden="true" />
                  {t('whatsappLabel')}
                </a>
              </li>
            )}
            {phone.length > 0 && (
              <li>
                <a
                  href={`tel:${phone.replace(/\s/g, '')}`}
                  className="inline-flex items-center gap-2 transition-colors hover:text-accent-deep"
                >
                  <Phone className="h-4 w-4" aria-hidden="true" />
                  {phone}
                </a>
              </li>
            )}
          </ul>
        </div>
      </div>

      <div className="border-border/60 border-t">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-5 text-[13px] text-muted">
          <span>{t('copyright')}</span>
          <Link href="/confidentialite" className="transition-colors hover:text-text">
            {t('privacy')}
          </Link>
        </div>
      </div>
    </footer>
  );
}
