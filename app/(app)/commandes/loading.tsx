import { ResourceRowSkeleton } from '@/components/ui/skeleton';

export default function CommandesLoading() {
  return (
    <main className="space-y-6" id="main">
      <div className="space-y-2">
        <div className="dashboard-shimmer h-10 w-40 rounded-sm" />
        <div className="dashboard-shimmer h-5 w-80 rounded-sm" />
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {['chip-1', 'chip-2', 'chip-3', 'chip-4'].map((key) => (
          <div className="dashboard-shimmer h-11 w-32 rounded-full" key={key} />
        ))}
      </div>
      <section className="overflow-hidden rounded-lg border border-border bg-surface shadow-1">
        {['row-1', 'row-2', 'row-3', 'row-4', 'row-5', 'row-6'].map((key) => (
          <ResourceRowSkeleton key={key} />
        ))}
      </section>
    </main>
  );
}
