import {
  LayoutDashboard,
  type LucideIcon,
  Package,
  RefreshCw,
  Sparkles,
  TrendingDown,
  Wallet,
} from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { Reveal, Stagger, StaggerItem } from './motion';

// Bento asymétrique des bénéfices. Carte large = analyse des pertes (le moat).
// Mobile = 1 colonne. Chaque carte : icône + titre bénéfice + détail produit.

const LOSS_BARS = [38, 62, 30, 78, 46, 70, 52];

function CardShell({
  icon: Icon,
  title,
  body,
  className,
  children,
}: {
  icon: LucideIcon;
  title: string;
  body: string;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <StaggerItem className={className}>
      <div className="flex h-full flex-col rounded-2xl border border-border bg-surface p-6 shadow-warm-1 transition duration-200 hover:-translate-y-0.5 hover:shadow-warm-2">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent-subtle text-accent-deep">
          <Icon className="h-5 w-5" aria-hidden="true" />
        </span>
        <h3 className="mt-4 font-medium text-[17px] text-text">{title}</h3>
        <p className="mt-1.5 text-[14px] text-muted leading-6">{body}</p>
        {children}
      </div>
    </StaggerItem>
  );
}

export async function FeaturesBento() {
  const t = await getTranslations('marketing.features');

  return (
    <section id="fonctionnalites" className="scroll-mt-20 border-border/60 border-t bg-sunken/40">
      <div className="mx-auto max-w-6xl px-5 py-20 md:py-28">
        <Reveal className="mx-auto max-w-2xl text-center">
          <p className="font-medium text-[13px] text-accent-deep uppercase tracking-[0.14em]">
            {t('kicker')}
          </p>
          <h2 className="mt-4 text-balance font-display text-3xl tracking-[-0.01em] md:text-[2.5rem]">
            {t('title')}
          </h2>
        </Reveal>

        <Stagger className="mt-14 grid auto-rows-[1fr] grid-cols-1 gap-4 md:grid-cols-3">
          {/* Carte vedette : analyse des pertes */}
          <StaggerItem className="md:col-span-2 md:row-span-2">
            <div className="flex h-full flex-col rounded-2xl border border-border bg-surface p-7 shadow-warm-2">
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent-subtle text-accent-deep">
                <TrendingDown className="h-5 w-5" aria-hidden="true" />
              </span>
              <h3 className="mt-5 font-display text-2xl text-text md:text-3xl">
                {t('losses_title')}
              </h3>
              <p className="mt-3 max-w-md text-[15px] text-muted leading-7">{t('losses_body')}</p>

              {/* Mini-visuel pertes (illustratif, pur CSS) */}
              <div className="mt-auto pt-8">
                <div className="flex items-end gap-2" aria-hidden="true">
                  {LOSS_BARS.map((h, i) => (
                    <div
                      key={h}
                      className={`flex-1 rounded-t ${
                        i === LOSS_BARS.length - 1 ? 'bg-accent/70' : 'bg-danger/25'
                      }`}
                      style={{ height: `${h * 0.9 + 16}px` }}
                    />
                  ))}
                </div>
                <p className="mt-3 font-mono text-[12px] text-danger tabular-nums">
                  − 23 500 F cette semaine
                </p>
              </div>
            </div>
          </StaggerItem>

          <CardShell
            icon={LayoutDashboard}
            title={t('dashboard_title')}
            body={t('dashboard_body')}
          />
          <CardShell icon={Package} title={t('stock_title')} body={t('stock_body')} />
          <CardShell icon={Wallet} title={t('cash_title')} body={t('cash_body')} />
          <CardShell icon={Sparkles} title={t('ai_title')} body={t('ai_body')} />
          <CardShell icon={RefreshCw} title={t('shopify_title')} body={t('shopify_body')} />
        </Stagger>
      </div>
    </section>
  );
}
