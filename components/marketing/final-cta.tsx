import { getTranslations } from 'next-intl/server';
import { CtaButton } from './cta-button';
import { Reveal } from './motion';

// CTA final — répète l'action unique.
export async function FinalCta() {
  const t = await getTranslations('marketing.finalCta');

  return (
    <section className="px-5 pb-20 md:pb-28">
      <Reveal className="mx-auto max-w-4xl">
        <div className="relative overflow-hidden rounded-3xl border border-border bg-surface px-6 py-16 text-center shadow-warm-2 md:py-20">
          <div
            className="-z-10 pointer-events-none absolute inset-0"
            style={{
              background:
                'radial-gradient(60% 80% at 50% 0%, rgba(238,131,67,0.14) 0%, rgba(238,131,67,0) 70%)',
            }}
          />
          <h2 className="mx-auto max-w-2xl text-balance font-display text-3xl leading-[1.1] tracking-[-0.01em] md:text-[2.75rem]">
            {t('title')}
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-[16px] text-muted leading-7">{t('subtitle')}</p>
          <div className="mt-8 flex justify-center">
            <CtaButton href="/connexion?mode=signup">{t('cta')}</CtaButton>
          </div>
        </div>
      </Reveal>
    </section>
  );
}
