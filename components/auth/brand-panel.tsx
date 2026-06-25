'use client';

import { Wordmark } from '@/components/wordmark';
import { useTranslations } from 'next-intl';

export function BrandPanel() {
  const t = useTranslations('auth');
  return (
    <div className="relative flex flex-shrink-0 items-center bg-canvas px-7 py-7 md:w-[44%] md:flex-col md:items-start md:justify-between md:px-14 md:py-16">
      <div aria-hidden="true" className="absolute inset-0 bg-grid opacity-60" />
      <div
        aria-hidden="true"
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse 90% 80% at 10% 10%, rgba(238,130,67,0.14) 0%, transparent 65%)',
        }}
      />
      <div className="relative z-10">
        <Wordmark className="text-3xl md:text-6xl" size="md" />
      </div>
      {/* #a8500f on #f4f3ed = 4.96:1, passes WCAG AA for normal text */}
      <p
        className="relative z-10 mt-auto hidden font-display-italic text-xl leading-8 md:block"
        style={{ color: '#a8500f' }}
      >
        {t('brand.tagline_line1')}
        <br />
        {t('brand.tagline_line2')}
      </p>
    </div>
  );
}
