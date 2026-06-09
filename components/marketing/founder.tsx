import { Lock, MapPin, ShieldCheck } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { Reveal } from './motion';

// Bloc fondateur / crédibilité — pas de mur de logos (early-stage assumé) :
// conçu à Dakar + garantie « tes données t'appartiennent ».
export async function FounderSection() {
  const t = await getTranslations('marketing.founder');

  return (
    <section>
      <div className="mx-auto grid max-w-6xl gap-10 px-5 py-20 md:grid-cols-2 md:py-28">
        <Reveal>
          <p className="inline-flex items-center gap-2 font-medium text-[13px] text-accent-deep uppercase tracking-[0.14em]">
            <MapPin className="h-4 w-4" aria-hidden="true" />
            {t('kicker')}
          </p>
          <h2 className="mt-4 text-balance font-display text-3xl leading-[1.12] tracking-[-0.01em] md:text-[2.5rem]">
            {t('title')}
          </h2>
          <p className="mt-5 max-w-md text-[16px] text-muted leading-7">{t('body')}</p>
        </Reveal>

        <Reveal delay={0.1} className="flex flex-col justify-center">
          <div className="rounded-2xl border border-border bg-surface p-7 shadow-warm-2">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-success-subtle text-success">
              <ShieldCheck className="h-5 w-5" aria-hidden="true" />
            </span>
            <h3 className="mt-5 font-medium text-[19px] text-text">{t('privacy_title')}</h3>
            <p className="mt-2 text-[15px] text-muted leading-7">{t('privacy_body')}</p>
            <p className="mt-5 inline-flex items-center gap-2 border-border/70 border-t pt-5 text-[14px] text-text">
              <Lock className="h-4 w-4 text-accent-deep" aria-hidden="true" />
              {t('early')}
            </p>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
