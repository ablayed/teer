import { getTranslations } from 'next-intl/server';
import { Reveal, Stagger, StaggerItem } from './motion';

// « Comment ça marche » — 3 étapes. Cible de l'ancre #comment (CTA secondaire du hero).
export async function StepsSection() {
  const t = await getTranslations('marketing.steps');

  const steps = [
    { n: '1', title: t('one_title'), body: t('one_body') },
    { n: '2', title: t('two_title'), body: t('two_body') },
    { n: '3', title: t('three_title'), body: t('three_body') },
  ];

  return (
    <section id="comment" className="scroll-mt-20">
      <div className="mx-auto max-w-6xl px-5 py-20 md:py-28">
        <Reveal className="mx-auto max-w-2xl text-center">
          <p className="font-medium text-[13px] text-accent-deep uppercase tracking-[0.14em]">
            {t('kicker')}
          </p>
          <h2 className="mt-4 text-balance font-display text-3xl tracking-[-0.01em] md:text-[2.5rem]">
            {t('title')}
          </h2>
        </Reveal>

        <Stagger className="mt-14 grid gap-5 md:grid-cols-3">
          {steps.map((step) => (
            <StaggerItem key={step.n}>
              <div className="h-full rounded-2xl border border-border bg-surface p-7 shadow-warm-1">
                <span className="flex h-11 w-11 items-center justify-center rounded-full bg-accent-subtle font-display font-semibold text-[20px] text-accent-deep tabular-nums">
                  {step.n}
                </span>
                <h3 className="mt-5 font-medium text-[19px] text-text">{step.title}</h3>
                <p className="mt-2 text-[15px] text-muted leading-7">{step.body}</p>
              </div>
            </StaggerItem>
          ))}
        </Stagger>
      </div>
    </section>
  );
}
