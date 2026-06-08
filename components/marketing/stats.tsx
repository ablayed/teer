import { getTranslations } from 'next-intl/server';
import { CountUp } from './count-up';
import { Reveal } from './motion';

// Bande de stats — compteurs animés au scroll. Bande crème sombre (ink chaud)
// pour le rythme. Chiffres = OBJECTIFS honnêtes (disclaimer explicite), jamais
// des résultats fabriqués.
export async function StatsSection() {
  const t = await getTranslations('marketing.stats');

  const stats = [
    { value: 15, prefix: '+', suffix: t('delivered_suffix'), label: t('delivered_label') },
    { value: 100, prefix: '', suffix: t('cash_suffix'), label: t('cash_label') },
    { value: 6, prefix: '', suffix: t('hours_suffix'), label: t('hours_label') },
  ];

  return (
    <section className="bg-[#2a2622] text-[#f4f3ed]">
      <div className="mx-auto max-w-6xl px-5 py-20 md:py-24">
        <Reveal className="mx-auto max-w-2xl text-center">
          <p className="font-medium text-[13px] text-accent uppercase tracking-[0.14em]">
            {t('kicker')}
          </p>
          <h2 className="mt-4 text-balance font-display text-3xl tracking-[-0.01em] md:text-[2.5rem]">
            {t('title')}
          </h2>
        </Reveal>

        <Reveal className="mt-14 grid gap-8 sm:grid-cols-3" delay={0.1}>
          {stats.map((stat) => (
            <div key={stat.label} className="text-center">
              <p className="font-semibold text-5xl text-accent md:text-6xl">
                <CountUp value={stat.value} prefix={stat.prefix} suffix={stat.suffix} />
              </p>
              <p className="mx-auto mt-3 max-w-[14rem] text-[15px] text-[#f4f3ed]/70 leading-6">
                {stat.label}
              </p>
            </div>
          ))}
        </Reveal>

        <p className="mt-12 text-center text-[12px] text-[#f4f3ed]/45">{t('disclaimer')}</p>
      </div>
    </section>
  );
}
