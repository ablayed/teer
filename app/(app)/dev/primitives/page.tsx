import { DemoCodStatusBadge } from '@/app/(app)/dev/primitives/_demo-cod-status';
import { DemoDetailPanel } from '@/app/(app)/dev/primitives/_demo-detail-panel';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { ResourceRow } from '@/components/ui/resource-row';
import { ResourceRowSkeleton, StatCardSkeleton } from '@/components/ui/skeleton';
import { StatCard } from '@/components/ui/stat-card';
import { StatusBadge } from '@/components/ui/status-badge';
import { orderStatuses } from '@/lib/domain/order-state-machine';
import { Package, ShoppingBag } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';

export default async function PrimitivesDemoPage() {
  if (process.env.ENABLE_PRIMITIVES_DEMO !== '1') notFound();

  const tCodStatus = await getTranslations('orders.codStatus');

  return (
    <main className="space-y-12 pb-16" id="main">
      <div data-testid="primitives-demo">
        <div className="mb-8 border-b border-border pb-4">
          <h1 className="text-2xl font-semibold text-text">Galerie primitives</h1>
          <p className="mt-1 text-sm text-muted">
            Composants mobile-first isolés — Phase 1 Socle 2/2
          </p>
        </div>

        {/* ── StatusBadge ── */}
        <section className="space-y-4">
          <h2 className="text-lg font-semibold text-text">StatusBadge — tons sémantiques</h2>
          <div className="flex flex-wrap gap-2">
            <StatusBadge label="Neutre" tone="neutral" />
            <StatusBadge label="Info" tone="info" />
            <StatusBadge label="Succès" tone="success" />
            <StatusBadge label="Avertissement" tone="warning" />
            <StatusBadge label="Danger" tone="danger" />
          </div>

          <h3 className="text-sm font-semibold text-muted">
            Tokens --status-* (démonstration isolée)
          </h3>
          <div className="flex flex-wrap gap-2">
            {orderStatuses.map((status) => (
              <DemoCodStatusBadge key={status} label={tCodStatus(status)} status={status} />
            ))}
          </div>
        </section>

        {/* ── ResourceRow ── */}
        <section className="mt-10 space-y-4">
          <h2 className="text-lg font-semibold text-text">ResourceRow — 3 largeurs</h2>
          <div className="flex flex-wrap items-start gap-4">
            {/* Étroit */}
            <div className="w-[320px]">
              <p className="mb-1 text-xs text-muted">320 px — méta masqué</p>
              <div className="rounded-lg border border-border bg-surface">
                <ResourceRow
                  href="#"
                  leading={
                    <span className="flex size-8 items-center justify-center rounded-full bg-accent-subtle text-accent-deep text-xs font-bold">
                      FD
                    </span>
                  }
                  meta="45 000 F CFA · EN_LIVRAISON"
                  status={<StatusBadge label="En livraison" tone="info" />}
                  title="Fatou Diallo"
                />
                <ResourceRow
                  href="#"
                  leading={
                    <span className="flex size-8 items-center justify-center rounded-full bg-success-subtle text-success text-xs font-bold">
                      MN
                    </span>
                  }
                  meta="12 500 F CFA · LIVREE"
                  status={<StatusBadge label="Livrée" tone="success" />}
                  title="Moussa Ndiaye"
                />
                <ResourceRow
                  href="#"
                  leading={
                    <span className="flex size-8 items-center justify-center rounded-full bg-danger-subtle text-danger text-xs font-bold">
                      AS
                    </span>
                  }
                  meta="89 000 F CFA · REFUSEE"
                  status={<StatusBadge label="Refusée" tone="danger" />}
                  title="Aminata Sow"
                />
              </div>
            </div>

            {/* Moyen */}
            <div className="w-[480px]">
              <p className="mb-1 text-xs text-muted">480 px — méta visible</p>
              <div className="rounded-lg border border-border bg-surface">
                <ResourceRow
                  href="#"
                  leading={
                    <span className="flex size-8 items-center justify-center rounded-full bg-accent-subtle text-accent-deep text-xs font-bold">
                      ID
                    </span>
                  }
                  meta="67 500 F CFA · Commande #1042"
                  status={<StatusBadge label="Confirmée" tone="info" />}
                  title="Ibrahima Diop"
                />
                <ResourceRow
                  href="#"
                  leading={
                    <span className="flex size-8 items-center justify-center rounded-full bg-success-subtle text-success text-xs font-bold">
                      OB
                    </span>
                  }
                  meta="23 000 F CFA · Commande #1041"
                  status={<StatusBadge label="Livrée" tone="success" />}
                  title="Oumy Badiane"
                />
              </div>
            </div>

            {/* Large */}
            <div className="w-full">
              <p className="mb-1 text-xs text-muted">Pleine largeur — trailing actions</p>
              <div className="rounded-lg border border-border bg-surface">
                <ResourceRow
                  href="#"
                  leading={<ShoppingBag aria-hidden="true" className="size-5 text-muted" />}
                  meta="Wax indigo · 3 en stock"
                  overflow={
                    <button
                      aria-label="Plus d'actions"
                      className="inline-flex size-11 items-center justify-center rounded-md text-muted hover:bg-canvas"
                      type="button"
                    >
                      ···
                    </button>
                  }
                  primaryAction={
                    <Button size="sm" variant="secondary">
                      Modifier
                    </Button>
                  }
                  status={<StatusBadge label="Actif" tone="success" />}
                  title="Ensemble wax indigo"
                />
                <ResourceRow
                  href="#"
                  leading={<Package aria-hidden="true" className="size-5 text-muted" />}
                  meta="Bazin brodé · 1 en stock"
                  overflow={
                    <button
                      aria-label="Plus d'actions"
                      className="inline-flex size-11 items-center justify-center rounded-md text-muted hover:bg-canvas"
                      type="button"
                    >
                      ···
                    </button>
                  }
                  primaryAction={
                    <Button size="sm" variant="secondary">
                      Modifier
                    </Button>
                  }
                  status={<StatusBadge label="Stock bas" tone="warning" />}
                  title="Bazin brodé or"
                />
              </div>
            </div>
          </div>
        </section>

        {/* ── PageHeader ── */}
        <section className="mt-10 space-y-4">
          <h2 className="text-lg font-semibold text-text">PageHeader</h2>
          <div className="rounded-lg border border-border bg-surface p-4">
            <PageHeader
              action={
                <Button size="sm" variant="primary">
                  Ajouter
                </Button>
              }
              subtitle="Gérez vos clients et suivez leurs commandes."
              title="Clients"
            />
          </div>
          <div className="rounded-lg border border-border bg-surface p-4">
            <PageHeader subtitle="Aucune action secondaire." title="Commandes récentes" />
          </div>
        </section>

        {/* ── StatCard ── */}
        <section className="mt-10 space-y-4">
          <h2 className="text-lg font-semibold text-text">StatCard — 3 largeurs</h2>
          <div className="flex flex-wrap items-start gap-4">
            <div className="w-[120px]">
              <p className="mb-1 text-xs text-muted">120 px — compact</p>
              <StatCard label="Commandes" value="142" />
            </div>
            <div className="w-[200px]">
              <p className="mb-1 text-xs text-muted">200 px — standard</p>
              <StatCard
                delta="+12 % vs mois dernier"
                label="Chiffre d'affaires"
                value="1 245 000 F"
              />
            </div>
            <div className="w-[320px]">
              <p className="mb-1 text-xs text-muted">320 px — riche</p>
              <StatCard
                delta="Taux de livraison · 7 derniers jours"
                label="Taux de livraison"
                value="87,4 %"
              />
            </div>
          </div>
        </section>

        {/* ── EmptyState ── */}
        <section className="mt-10 space-y-4">
          <h2 className="text-lg font-semibold text-text">EmptyState</h2>
          <div className="grid gap-4 md:grid-cols-2">
            <EmptyState
              action={<Button size="sm">Ajouter un client</Button>}
              description="Commencez par ajouter votre premier client."
              title="Aucun client pour le moment"
            />
            <EmptyState
              action={
                <Button size="sm" variant="secondary">
                  Synchroniser
                </Button>
              }
              description="Connectez Shopify pour importer vos commandes."
              illustration={<ShoppingBag className="size-10" />}
              title="Aucune commande"
            />
          </div>
        </section>

        {/* ── Skeleton ── */}
        <section className="mt-10 space-y-4">
          <h2 className="text-lg font-semibold text-text">Skeleton</h2>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <p className="mb-2 text-xs text-muted">ResourceRowSkeleton × 3</p>
              <div className="rounded-lg border border-border bg-surface">
                <ResourceRowSkeleton />
                <ResourceRowSkeleton />
                <ResourceRowSkeleton />
              </div>
            </div>
            <div>
              <p className="mb-2 text-xs text-muted">StatCardSkeleton × 2</p>
              <div className="space-y-3">
                <StatCardSkeleton />
                <StatCardSkeleton />
              </div>
            </div>
          </div>
        </section>

        {/* ── DetailPanel ── */}
        <section className="mt-10 space-y-4">
          <h2 className="text-lg font-semibold text-text">DetailPanel</h2>
          <p className="text-sm text-muted">
            Mobile : bottom-sheet Vaul. Desktop : panneau latéral avec scrim. Contrôlé par state.
          </p>
          <DemoDetailPanel />
        </section>
      </div>
    </main>
  );
}
