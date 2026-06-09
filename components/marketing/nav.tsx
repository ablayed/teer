import { Wordmark } from '@/components/wordmark';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';

// Nav sticky, server component (zéro JS). Ancres masquées sur mobile (la barre CTA
// sticky mobile, Stage 5, prend le relais pour la conversion).
export async function MarketingNav() {
  const t = await getTranslations('marketing.nav');

  const links = [
    { href: '#fonctionnalites', label: t('features') },
    { href: '#tarifs', label: t('pricing') },
    { href: '#faq', label: t('faq') },
  ];

  return (
    <header className="sticky top-0 z-50 border-border/70 border-b bg-canvas/80 backdrop-blur">
      <nav className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5">
        <Link href="/" aria-label="Tëër" className="shrink-0">
          <Wordmark size="md" />
        </Link>

        <div className="hidden items-center gap-8 sm:flex">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="text-[14px] text-muted transition-colors hover:text-text"
            >
              {link.label}
            </Link>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <Link
            href="/connexion"
            className="hidden min-h-[44px] items-center px-3 text-[14px] font-medium text-text transition-colors hover:text-accent-deep sm:inline-flex"
          >
            {t('connexion')}
          </Link>
          <Link
            href="/connexion?mode=signup"
            className="inline-flex min-h-[40px] items-center rounded-full bg-accent px-4 py-2 text-[14px] font-medium text-[#111] shadow-warm-1 transition duration-200 hover:bg-accent-hover"
          >
            {t('cta')}
          </Link>
        </div>
      </nav>
    </header>
  );
}
