import { getTranslations } from 'next-intl/server';
import { Reveal } from './motion';

// Agitation du problème. Bande crème sombre (--sunken) pour le rythme des sections.
export async function ProblemSection() {
  const t = await getTranslations('marketing.problem');

  return (
    <section className="border-border/60 border-y bg-sunken/50">
      <div className="mx-auto max-w-3xl px-5 py-20 md:py-28">
        <Reveal>
          <p className="font-medium text-[13px] text-danger uppercase tracking-[0.14em]">
            {t('kicker')}
          </p>
          <h2 className="mt-4 text-balance font-display text-3xl leading-[1.12] tracking-[-0.01em] md:text-[2.75rem]">
            {t('title')}
          </h2>
          <p className="mt-6 border-danger/40 border-l-2 pl-5 text-[17px] text-muted leading-8 md:text-lg">
            {t('body')}
          </p>
        </Reveal>
      </div>
    </section>
  );
}
