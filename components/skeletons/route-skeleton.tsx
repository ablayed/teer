/**
 * Squelettes de route (LOT PERF #4) — fallback `loading.tsx` instantané pendant
 * la navigation vers une route dynamique du groupe (app). Dimensions calées sur
 * le contenu final pour éviter le CLS. Utilise l'utilitaire `dashboard-shimmer`
 * existant. Composant serveur pur (aucun état).
 */

const ROW_KEYS = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8'] as const;
const CARD_KEYS = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'] as const;

function Header() {
  return (
    <div className="space-y-2">
      <div className="dashboard-shimmer h-10 w-48 rounded-sm md:h-12" />
      <div className="dashboard-shimmer h-5 w-72 rounded-sm" />
    </div>
  );
}

function Chips() {
  return (
    <div className="flex gap-2 overflow-x-auto pb-1">
      {['chip-1', 'chip-2', 'chip-3', 'chip-4'].map((key) => (
        <div className="dashboard-shimmer h-11 w-32 shrink-0 rounded-full" key={key} />
      ))}
    </div>
  );
}

function ListRows({ count = 6 }: { count?: number }) {
  return (
    <section className="space-y-3">
      {ROW_KEYS.slice(0, count).map((key) => (
        <div className="dashboard-shimmer h-24 rounded-lg" key={key} />
      ))}
    </section>
  );
}

function CardsGrid({ count = 4 }: { count?: number }) {
  return (
    <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {CARD_KEYS.slice(0, count).map((key) => (
        <div className="dashboard-shimmer min-h-[140px] rounded-lg" key={key} />
      ))}
    </section>
  );
}

function Chart() {
  return (
    <section className="rounded-lg border border-border bg-surface p-4 shadow-1 md:p-6">
      <div className="dashboard-shimmer mb-5 h-5 w-40 rounded-sm" />
      <div className="dashboard-shimmer h-[260px] rounded-md" />
    </section>
  );
}

function FormRows() {
  return (
    <section className="max-w-xl space-y-5 rounded-lg border border-border bg-surface p-4 shadow-1 md:p-6">
      {ROW_KEYS.slice(0, 5).map((key) => (
        <div className="space-y-2" key={key}>
          <div className="dashboard-shimmer h-4 w-32 rounded-sm" />
          <div className="dashboard-shimmer h-11 w-full rounded-md" />
        </div>
      ))}
    </section>
  );
}

function ChatBubbles() {
  return (
    <section className="space-y-4">
      <div className="dashboard-shimmer h-16 w-2/3 rounded-lg" />
      <div className="dashboard-shimmer ml-auto h-12 w-1/2 rounded-lg" />
      <div className="dashboard-shimmer h-20 w-3/4 rounded-lg" />
      <div className="dashboard-shimmer ml-auto h-11 w-2/5 rounded-lg" />
    </section>
  );
}

function DetailBody() {
  return (
    <section className="grid gap-4 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        <div className="dashboard-shimmer h-40 rounded-lg" />
        <div className="dashboard-shimmer h-56 rounded-lg" />
      </div>
      <div className="space-y-4">
        <div className="dashboard-shimmer h-32 rounded-lg" />
        <div className="dashboard-shimmer h-44 rounded-lg" />
      </div>
    </section>
  );
}

type Variant = 'list' | 'cards' | 'dashboard' | 'form' | 'chat' | 'detail';

export function RouteSkeleton({ variant }: { variant: Variant }) {
  return (
    <main className="space-y-6" id="main">
      <Header />
      {variant === 'list' ? (
        <>
          <Chips />
          <ListRows />
        </>
      ) : null}
      {variant === 'cards' ? <CardsGrid count={6} /> : null}
      {variant === 'dashboard' ? (
        <>
          <CardsGrid count={4} />
          <Chart />
        </>
      ) : null}
      {variant === 'form' ? <FormRows /> : null}
      {variant === 'chat' ? <ChatBubbles /> : null}
      {variant === 'detail' ? <DetailBody /> : null}
    </main>
  );
}
