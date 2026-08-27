import { Amount } from '@/components/ui/amount';
import { EmptyState } from '@/components/ui/empty-state';
import type { ExplanationCardRow } from '@/components/ui/explanation-card';
import { ExplanationCard } from '@/components/ui/explanation-card';
import { GainLoss } from '@/components/ui/gain-loss';
import { InsufficientDataState } from '@/components/ui/insufficient-data-state';
import { ListCard } from '@/components/ui/list-card';
import { ScopedMetricCard } from '@/components/ui/scoped-metric-card';
import { ValueAmount } from '@/components/ui/value-state';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { LockKeyhole } from 'lucide-react';

/**
 * Page de démonstration — Phase F · Lot U1-F. Route directe, non liée à la navigation
 * (components/app-shell/sidebar.tsx et bottom-tab-nav.tsx non touchés). Données 100% fictives,
 * déclarées inline ci-dessous : aucun appel Supabase de lecture métier, aucune action serveur.
 * Un test (tests/unit/ui/demo-page-no-real-data.test.ts) garantit l'absence de tout import de
 * lecture de données réelles dans ce fichier.
 */

async function getCurrentMember() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { merchantAccountId: null, role: null };

  const { data: member } = await supabase
    .from('merchant_member')
    .select('merchant_account_id, role')
    .eq('user_id', user.id)
    .limit(1)
    .maybeSingle();

  const currentMember = member as { merchant_account_id: string; role: string } | null;

  return {
    merchantAccountId: currentMember?.merchant_account_id ?? null,
    role: currentMember?.role ?? null,
  };
}

const marginRows: ExplanationCardRow[] = [
  { sentence: 'Tu as encaissé', sign: 'add', state: { kind: 'confirmed', amountMinor: 408_000 } },
  {
    sentence: 'Les articles vendus t’ont coûté',
    sign: 'subtract',
    state: { kind: 'confirmed', amountMinor: 251_940 },
  },
  {
    sentence: 'La publicité t’a coûté',
    sign: 'subtract',
    state: { kind: 'confirmed', amountMinor: 66_700 },
  },
];

const marginRowsWithGap: ExplanationCardRow[] = [
  ...marginRows,
  { sentence: 'Coût de reprise d’un colis refusé', sign: 'subtract', state: { kind: 'missing' } },
];

export default async function FinanceFoundationsDemoPage() {
  const { merchantAccountId, role } = await getCurrentMember();

  if (!merchantAccountId || (role !== 'owner' && role !== 'manager')) {
    return (
      <main className="space-y-6" id="main">
        <h1 className="font-display text-4xl md:text-5xl">Fondations d'interface</h1>
        <section className="flex max-w-2xl gap-3 rounded-lg border border-border bg-surface p-5 text-muted shadow-1">
          <LockKeyhole aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
          <p>Cette section est réservée au propriétaire et aux managers.</p>
        </section>
      </main>
    );
  }

  return (
    <main className="space-y-12 pb-16" id="main">
      <div data-testid="finance-foundations-demo">
        <div className="mb-8 border-b border-border pb-4">
          <h1 className="text-2xl font-semibold text-text">Fondations d'interface — finances</h1>
          <p className="mt-1 text-sm text-muted">
            Phase F · Lot U1-F — démonstration des sept composants, données fictives uniquement.
          </p>
        </div>

        {/* ── Montant ── */}
        <section className="space-y-4">
          <h2 className="text-lg font-semibold text-text">Montant</h2>
          <div className="flex flex-wrap items-baseline gap-6 rounded-lg border border-border bg-surface p-4">
            <Amount amountMinor={495_405} />
            <Amount amountMinor={1_539_116} />
            <Amount amountMinor={0} />
            <span className="text-xs text-muted">Abrégé (axe de graphe uniquement) :</span>
            <Amount abbreviateForAxis amountMinor={1_539_116} />
          </div>
          <div className="rounded-lg border border-border bg-surface p-4">
            <p className="mb-2 text-xs text-muted">
              Preuve 5.4 — chiffres tabulaires : `111111` et `888888` doivent occuper la même
              largeur (mesuré en navigateur réel, tests/e2e/lot-u1f-tabular-nums.spec.ts).
            </p>
            <div className="flex items-baseline gap-6 text-2xl">
              <span
                className="font-sans tabular-nums lining-nums"
                data-testid="tabular-nums-111111"
              >
                111111
              </span>
              <span
                className="font-sans tabular-nums lining-nums"
                data-testid="tabular-nums-888888"
              >
                888888
              </span>
            </div>
          </div>
        </section>

        {/* ── État d'une valeur ── */}
        <section className="mt-10 space-y-4">
          <h2 className="text-lg font-semibold text-text">État d'une valeur</h2>
          <div className="flex flex-wrap gap-6 rounded-lg border border-border bg-surface p-4">
            <ValueAmount state={{ kind: 'confirmed', amountMinor: 251_940 }} />
            <ValueAmount
              state={{ kind: 'estimated', amountMinor: 50_000, label: 'Coût à confirmer' }}
            />
            <ValueAmount state={{ kind: 'missing', label: 'Coût non renseigné' }} />
          </div>
        </section>

        {/* ── Gain et perte ── */}
        <section className="mt-10 space-y-4">
          <h2 className="text-lg font-semibold text-text">Gain et perte</h2>
          <div className="flex flex-wrap gap-6 rounded-lg border border-border bg-surface p-4">
            <GainLoss
              amountMinor={89_360}
              labels={{ gain: 'Gain', loss: 'Perte', neutral: 'Stable' }}
            />
            <GainLoss
              amountMinor={-15_000}
              labels={{ gain: 'Gain', loss: 'Perte', neutral: 'Stable' }}
            />
            <GainLoss amountMinor={0} labels={{ gain: 'Gain', loss: 'Perte', neutral: 'Stable' }} />
          </div>
        </section>

        {/* ── Portée temporelle ── */}
        <section className="mt-10 space-y-4">
          <h2 className="text-lg font-semibold text-text">Portée temporelle</h2>
          <div className="flex flex-wrap items-start gap-4">
            <div className="w-[220px]">
              <ScopedMetricCard
                label="Argent chez le livreur"
                scope={{ kind: 'balance', asOfLabel: '27 août 2026' }}
                value={<Amount amountMinor={1_539_116} />}
              />
            </div>
            <div className="w-[220px]">
              <ScopedMetricCard
                label="CA encaissé"
                scope={{ kind: 'flow', periodLabel: '30 derniers jours' }}
                value={<Amount amountMinor={495_405} />}
              />
            </div>
          </div>
        </section>

        {/* ── Carte à explication ── */}
        <section className="mt-10 space-y-4">
          <h2 className="text-lg font-semibold text-text">Carte à explication</h2>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <p className="mb-1 text-xs text-muted">Lignes complètes</p>
              <ExplanationCard
                label="Marge"
                rows={marginRows}
                scope={{ kind: 'flow', periodLabel: '30 derniers jours' }}
                totalSentence="Il te reste"
              />
            </div>
            <div>
              <p className="mb-1 text-xs text-muted">Une ligne manquante — pas de total inventé</p>
              <ExplanationCard
                label="Marge"
                rows={marginRowsWithGap}
                scope={{ kind: 'flow', periodLabel: '30 derniers jours' }}
                totalSentence="Il te reste"
              />
            </div>
          </div>
        </section>

        {/* ── Carte de liste ── */}
        <section className="mt-10 space-y-4">
          <h2 className="text-lg font-semibold text-text">Carte de liste</h2>
          <div className="grid gap-3 md:max-w-md">
            <ListCard
              primaryValue={<Amount amountMinor={45_000} />}
              secondary={[
                { label: 'Prix de revient', value: <Amount amountMinor={28_000} /> },
                { label: 'Arrivage', value: 'Lot du 12 août' },
              ]}
              title="Fatou Diallo"
            />
            <ListCard
              primaryValue={<Amount amountMinor={12_500} />}
              secondary={[{ label: 'Prix de revient', value: <Amount amountMinor={9_000} /> }]}
              title="Moussa Ndiaye"
            />
          </div>
          <div>
            <p className="mb-1 text-xs text-muted">
              Exception tableau — comparaison de plusieurs lignes sur une même métrique, 2 colonnes
              maximum, HTML natif (pas un composant de ce lot)
            </p>
            <div className="max-w-sm overflow-x-auto rounded-lg border border-border">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-border bg-canvas text-left">
                    <th className="px-3 py-2 font-medium text-muted">Article</th>
                    <th className="px-3 py-2 font-medium text-muted">Invendu</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b border-border last:border-0">
                    <td className="px-3 py-2 text-text">Wax indigo</td>
                    <td className="px-3 py-2 text-text">
                      <Amount amountMinor={18_000} />
                    </td>
                  </tr>
                  <tr>
                    <td className="px-3 py-2 text-text">Bazin brodé</td>
                    <td className="px-3 py-2 text-text">
                      <Amount amountMinor={9_500} />
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </section>

        {/* ── État vide ou insuffisant ── */}
        <section className="mt-10 space-y-4">
          <h2 className="text-lg font-semibold text-text">État vide ou insuffisant</h2>
          <div className="grid gap-4 md:grid-cols-2">
            <EmptyState
              description="Ajoutez un prix de revient pour voir votre marge."
              title="Aucune donnée pour le moment"
            />
            <div className="rounded-lg border border-dashed border-border bg-canvas p-6 text-center">
              <InsufficientDataState minimumRequired={10} observedCount={3} />
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
