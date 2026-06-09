import { Plus } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { Reveal } from './motion';

// FAQ — accordéon natif <details>/<summary> : zéro JS (CWV), accessible clavier.
function FaqItem({ question, answer }: { question: string; answer: string }) {
  return (
    <details className="group border-border border-b py-1">
      <summary className="flex min-h-[44px] cursor-pointer list-none items-center justify-between gap-4 py-4 text-[16px] font-medium text-text marker:hidden [&::-webkit-details-marker]:hidden">
        {question}
        <Plus
          className="h-5 w-5 shrink-0 text-accent-deep transition-transform duration-200 group-open:rotate-45"
          aria-hidden="true"
        />
      </summary>
      <p className="pb-4 text-[15px] text-muted leading-7">{answer}</p>
    </details>
  );
}

export async function FaqSection() {
  const t = await getTranslations('marketing.faq');

  const items = [
    { q: t('data_q'), a: t('data_a') },
    { q: t('channels_q'), a: t('channels_a') },
    { q: t('cancel_q'), a: t('cancel_a') },
    { q: t('mobile_q'), a: t('mobile_a') },
  ];

  return (
    <section id="faq" className="scroll-mt-20">
      <div className="mx-auto max-w-3xl px-5 py-20 md:py-28">
        <Reveal className="text-center">
          <p className="font-medium text-[13px] text-accent-deep uppercase tracking-[0.14em]">
            {t('kicker')}
          </p>
          <h2 className="mt-4 text-balance font-display text-3xl tracking-[-0.01em] md:text-[2.5rem]">
            {t('title')}
          </h2>
        </Reveal>

        <Reveal className="mt-12" delay={0.1}>
          {items.map((item) => (
            <FaqItem key={item.q} question={item.q} answer={item.a} />
          ))}
        </Reveal>
      </div>
    </section>
  );
}
