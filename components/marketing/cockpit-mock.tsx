import { Check } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

// Maquette in-DOM du cockpit COD (board commandes + pills + carte cash + mini-graphe SVG).
// 100 % HTML/CSS/SVG : aucune lib de chart, aucune interactivité → élément LCP qui
// peint instantanément, INP intact. Chiffres illustratifs (badge explicite).
// Réutilise les tokens/règles de marque réels : mono tnum, pills de statut, F CFA.

type Tone = 'neutral' | 'confirmed' | 'delivering' | 'delivered' | 'returned';

function StatusPill({ label, tone }: { label: string; tone: Tone }) {
  const tones: Record<Tone, string> = {
    neutral: 'bg-sunken text-text/65',
    confirmed: 'bg-success-subtle text-success',
    delivering: 'bg-accent-subtle text-accent-deep',
    delivered: 'bg-success text-white',
    returned: 'bg-danger-subtle text-danger',
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium ${tones[tone]}`}
    >
      {label}
    </span>
  );
}

function OrderRow({
  initials,
  name,
  phone,
  pill,
  amount,
}: {
  initials: string;
  name: string;
  phone: string;
  pill: { label: string; tone: Tone };
  amount: string;
}) {
  return (
    <div className="flex items-center gap-3 border-border/60 border-b px-4 py-2.5 last:border-b-0">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-canvas font-medium text-[11px] text-muted">
        {initials}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-[13px] text-text">{name}</p>
        <p className="truncate font-mono text-[11px] text-muted tabular-nums">{phone}</p>
      </div>
      <StatusPill label={pill.label} tone={pill.tone} />
      <span className="w-[68px] shrink-0 text-right font-mono text-[12px] text-text tabular-nums">
        {amount}
      </span>
    </div>
  );
}

// Hauteurs des barres (pertes / jour), en %. Dernière barre = aujourd'hui (accent).
const LOSS_BARS = [38, 62, 30, 78, 46, 70, 52];

export async function CockpitMock() {
  const t = await getTranslations('marketing.mock');

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-warm-3">
      {/* Chrome navigateur */}
      <div className="flex items-center gap-3 border-border border-b bg-canvas/70 px-4 py-2.5">
        <div className="flex gap-1.5" aria-hidden="true">
          <span className="h-2.5 w-2.5 rounded-full bg-danger/40" />
          <span className="h-2.5 w-2.5 rounded-full bg-warning/40" />
          <span className="h-2.5 w-2.5 rounded-full bg-success/40" />
        </div>
        <div className="mx-auto w-full max-w-[280px] truncate rounded-md bg-surface px-3 py-1 text-center font-mono text-[11px] text-muted">
          {t('url')}
        </div>
      </div>

      {/* Corps */}
      <div className="grid gap-3 p-3 md:grid-cols-5">
        {/* Board commandes */}
        <div className="overflow-hidden rounded-xl border border-border/80 bg-canvas/40 md:col-span-3">
          <div className="flex items-center justify-between px-4 py-2.5">
            <p className="font-medium text-[13px] text-text">{t('ordersTitle')}</p>
            <span className="rounded-full bg-accent-subtle px-2 py-0.5 font-mono text-[11px] text-accent-deep tabular-nums">
              5
            </span>
          </div>
          <div className="border-border/60 border-t">
            <OrderRow
              initials="AD"
              name="Awa Diop"
              phone="77 123 45 67"
              pill={{ label: t('statusConfirmed'), tone: 'confirmed' }}
              amount="24 000"
            />
            <OrderRow
              initials="CF"
              name="Cheikh Fall"
              phone="78 902 11 34"
              pill={{ label: t('statusDelivering'), tone: 'delivering' }}
              amount="18 500"
            />
            <OrderRow
              initials="FN"
              name="Fatou Ndiaye"
              phone="76 540 98 22"
              pill={{ label: t('statusToCall'), tone: 'neutral' }}
              amount="32 000"
            />
            <OrderRow
              initials="MS"
              name="Mamadou Sow"
              phone="70 333 70 08"
              pill={{ label: t('statusDelivered'), tone: 'delivered' }}
              amount="12 000"
            />
            <OrderRow
              initials="BB"
              name="Bineta Ba"
              phone="77 818 45 90"
              pill={{ label: t('statusReturned'), tone: 'returned' }}
              amount="9 500"
            />
          </div>
        </div>

        {/* Colonne droite : cash + pertes */}
        <div className="flex flex-col gap-3 md:col-span-2">
          {/* Cash à remettre */}
          <div className="rounded-xl border border-border/80 bg-canvas/40 p-4">
            <div className="flex items-center justify-between">
              <p className="font-medium text-[13px] text-text">{t('cashTitle')}</p>
              <span className="inline-flex items-center gap-1 rounded-full bg-success-subtle px-2 py-0.5 text-[11px] text-success">
                <Check className="h-3 w-3" aria-hidden="true" />
                {t('cashReconciled')}
              </span>
            </div>
            <p className="mt-2 font-mono font-semibold text-[26px] text-text tabular-nums">
              156 000 <span className="font-normal text-[14px] text-muted">F CFA</span>
            </p>
            <p className="mt-0.5 text-[11px] text-muted">{t('cashDriver')}</p>
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-sunken" aria-hidden="true">
              <div className="h-full w-[82%] rounded-full bg-success" />
            </div>
          </div>

          {/* Pertes — mini graphe (barres SVG-less, pur CSS) */}
          <div className="flex-1 rounded-xl border border-border/80 bg-canvas/40 p-4">
            <div className="flex items-baseline justify-between">
              <p className="font-medium text-[13px] text-text">{t('lossesTitle')}</p>
              <span className="font-mono font-medium text-[12px] text-danger tabular-nums">
                − 23 500
              </span>
            </div>
            <div className="mt-3 flex h-14 items-end gap-1.5" aria-hidden="true">
              {LOSS_BARS.map((h, i) => (
                <div
                  key={h}
                  className={`flex-1 rounded-t ${
                    i === LOSS_BARS.length - 1 ? 'bg-accent/70' : 'bg-danger/25'
                  }`}
                  style={{ height: `${h}%` }}
                />
              ))}
            </div>
            <p className="mt-2 text-[11px] text-muted">{t('lossesCaption')}</p>
          </div>
        </div>
      </div>

      {/* Badge honnêteté */}
      <p className="border-border/60 border-t px-4 py-2 text-center text-[10px] text-muted/80 uppercase tracking-wide">
        {t('badge')}
      </p>
    </div>
  );
}
