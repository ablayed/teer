import { CockpitMock } from '@/components/marketing/cockpit-mock';
import { CtaButton } from '@/components/marketing/cta-button';
import { FaqSection } from '@/components/marketing/faq';
import { FeaturesBento } from '@/components/marketing/features-bento';
import { FinalCta } from '@/components/marketing/final-cta';
import { MarketingFooter } from '@/components/marketing/footer';
import { FounderSection } from '@/components/marketing/founder';
import { MarketingNav } from '@/components/marketing/nav';
import { PricingSection } from '@/components/marketing/pricing';
import { ProblemSection } from '@/components/marketing/problem';
import { StatsSection } from '@/components/marketing/stats';
import { StepsSection } from '@/components/marketing/steps';
import { env } from '@/lib/env';
import { ArrowRight, Check } from 'lucide-react';
import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('marketing');
  const title = 'Tëër — Tableau de bord COD pour marchands Shopify au Sénégal';
  const description = t('hero.subtitle');

  return {
    title,
    description,
    keywords: [
      'paiement à la livraison',
      'COD Sénégal',
      'Shopify Sénégal',
      'tableau de bord COD',
      'cash à la livraison',
      'gestion livraison Dakar',
    ],
    alternates: { canonical: '/' },
    robots: { index: true, follow: true },
    openGraph: {
      title,
      description,
      url: '/',
      siteName: 'Tëër',
      locale: 'fr_SN',
      type: 'website',
    },
    twitter: { card: 'summary_large_image', title, description },
  };
}

export default async function MarketingPage() {
  const t = await getTranslations('marketing');

  const appUrl = env.NEXT_PUBLIC_APP_URL;
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        name: 'Tëër',
        url: appUrl,
        logo: `${appUrl}/icon-512.png`,
      },
      {
        '@type': 'SoftwareApplication',
        name: 'Tëër',
        applicationCategory: 'BusinessApplication',
        operatingSystem: 'Web, Android, iOS',
        description: t('hero.subtitle'),
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'XOF' },
      },
    ],
  };

  return (
    <div className="landing min-h-dvh bg-canvas pb-[76px] text-text md:pb-0">
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD statique de confiance
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <MarketingNav />

      <main>
        {/* HERO */}
        <section className="relative overflow-hidden">
          {/* Grille technique + glow radial, discrets, derrière le contenu */}
          <div className="-z-10 pointer-events-none absolute inset-0">
            <div className="absolute inset-0 bg-grid opacity-[0.4] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_30%,#000_30%,transparent_75%)]" />
            <div
              className="absolute inset-x-0 top-0 h-[520px]"
              style={{
                background:
                  'radial-gradient(60% 60% at 50% 0%, rgba(238,131,67,0.16) 0%, rgba(238,131,67,0) 70%)',
              }}
            />
          </div>

          <div className="mx-auto max-w-5xl px-5 pt-16 pb-10 text-center md:pt-24">
            <h1 className="mx-auto max-w-4xl text-balance font-display text-[2.75rem] leading-[1.04] tracking-[-0.02em] md:text-7xl">
              {t('hero.title_a')} {t('hero.title_b')}{' '}
              <span className="text-accent-deep italic">{t('hero.title_c')}</span>
              <br className="hidden sm:block" /> {t('hero.title_d')}
            </h1>

            <p className="mx-auto mt-6 max-w-2xl text-pretty text-[17px] text-muted leading-8 md:text-lg">
              {t('hero.subtitle')}
            </p>

            <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <CtaButton href="/connexion?mode=signup">{t('hero.cta')}</CtaButton>
              <CtaButton href="#comment" variant="secondary">
                {t('hero.ctaSecondary')}
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </CtaButton>
            </div>

            <p className="mt-5 inline-flex items-center gap-2 text-[13px] text-muted">
              <Check className="h-4 w-4 text-success" aria-hidden="true" />
              {t('hero.trust')}
            </p>
          </div>

          {/* Visuel produit — élément LCP : rendu immédiat (pas de reveal JS qui
              retarderait le LCP), pas d'image lazy. */}
          <div className="mx-auto max-w-5xl px-5 pb-16 md:pb-24">
            <CockpitMock />
          </div>
        </section>

        <ProblemSection />
        <StepsSection />
        <FeaturesBento />
        <StatsSection />
        <FounderSection />
        <PricingSection />
        <FaqSection />
        <FinalCta />
      </main>

      <MarketingFooter />

      {/* Barre CTA sticky mobile (server, zéro JS), safe-area iOS incluse */}
      <div
        className="fixed inset-x-0 bottom-0 z-40 border-border border-t bg-canvas/90 px-4 py-3 backdrop-blur md:hidden"
        style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}
      >
        <CtaButton href="/connexion?mode=signup" className="w-full">
          {t('hero.cta')}
        </CtaButton>
      </div>
    </div>
  );
}
