import { CockpitMock } from '@/components/marketing/cockpit-mock';
import { CtaButton } from '@/components/marketing/cta-button';
import { MarketingFooter } from '@/components/marketing/footer';
import { Reveal } from '@/components/marketing/motion';
import { MarketingNav } from '@/components/marketing/nav';
import { ArrowRight, Check } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

export default async function MarketingPage() {
  const t = await getTranslations('marketing');

  return (
    <div className="landing min-h-dvh bg-canvas text-text">
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
              <span className="text-accent italic">{t('hero.title_c')}</span>
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

          {/* Visuel produit — élément LCP (HTML/CSS, pas d'image lazy) */}
          <div className="mx-auto max-w-5xl px-5 pb-16 md:pb-24">
            <Reveal y={24}>
              <CockpitMock />
            </Reveal>
          </div>
        </section>
      </main>

      <MarketingFooter />
    </div>
  );
}
