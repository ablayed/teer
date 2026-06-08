import { Check } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { CtaButton } from './cta-button';
import { Reveal } from './motion';

function FeatureItem({ children }: { children: string }) {
  return (
    <li className="flex items-start gap-2.5 text-[14px] text-muted">
      <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
      <span>{children}</span>
    </li>
  );
}

// Tarifs — free tier proéminent (FCFA), Pro « bientôt ». Une seule action réelle.
export async function PricingSection() {
  const t = await getTranslations('marketing.pricing');

  return (
    <section id="tarifs" className="scroll-mt-20 border-border/60 border-t bg-sunken/40">
      <div className="mx-auto max-w-5xl px-5 py-20 md:py-28">
        <Reveal className="mx-auto max-w-2xl text-center">
          <p className="font-medium text-[13px] text-accent-deep uppercase tracking-[0.14em]">
            {t('kicker')}
          </p>
          <h2 className="mt-4 text-balance font-display text-3xl tracking-[-0.01em] md:text-[2.5rem]">
            {t('title')}
          </h2>
          <p className="mt-4 text-[16px] text-muted">{t('subtitle')}</p>
        </Reveal>

        <div className="mt-14 grid items-start gap-5 md:grid-cols-2">
          {/* Gratuit — proéminent */}
          <Reveal>
            <div className="rounded-3xl border-2 border-accent/50 bg-surface p-8 shadow-warm-2 ring-1 ring-accent/10">
              <p className="font-medium text-[15px] text-text">{t('free_name')}</p>
              <p className="mt-4 flex items-baseline gap-1.5">
                <span className="font-mono font-semibold text-5xl text-text tabular-nums">
                  {t('free_price')}
                </span>
                <span className="text-[15px] text-muted">{t('free_currency')}</span>
                <span className="text-[14px] text-muted">{t('free_period')}</span>
              </p>
              <p className="mt-2 text-[14px] text-muted">{t('free_tagline')}</p>
              <ul className="mt-6 flex flex-col gap-3">
                <FeatureItem>{t('free_f1')}</FeatureItem>
                <FeatureItem>{t('free_f2')}</FeatureItem>
                <FeatureItem>{t('free_f3')}</FeatureItem>
                <FeatureItem>{t('free_f4')}</FeatureItem>
              </ul>
              <CtaButton href="/connexion?mode=signup" className="mt-8 w-full">
                {t('free_cta')}
              </CtaButton>
            </div>
          </Reveal>

          {/* Pro — bientôt */}
          <Reveal delay={0.1}>
            <div className="rounded-3xl border border-border bg-canvas/50 p-8">
              <div className="flex items-center justify-between">
                <p className="font-medium text-[15px] text-text">{t('pro_name')}</p>
                <span className="rounded-full bg-accent-subtle px-2.5 py-0.5 text-[11px] font-medium text-accent-deep">
                  {t('pro_badge')}
                </span>
              </div>
              <p className="mt-4 font-display text-4xl text-text">{t('pro_price')}</p>
              <p className="mt-2 text-[14px] text-muted">{t('pro_tagline')}</p>
              <ul className="mt-6 flex flex-col gap-3">
                <FeatureItem>{t('pro_f1')}</FeatureItem>
                <FeatureItem>{t('pro_f2')}</FeatureItem>
                <FeatureItem>{t('pro_f3')}</FeatureItem>
                <FeatureItem>{t('pro_f4')}</FeatureItem>
              </ul>
              <CtaButton href="/connexion?mode=signup" variant="secondary" className="mt-8 w-full">
                {t('pro_cta')}
              </CtaButton>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
