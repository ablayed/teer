'use client';

export default function CommandesError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="space-y-6" id="main">
      <section className="rounded-lg border border-danger/30 bg-surface p-6 text-danger shadow-1">
        <div className="space-y-3">
          <h1 className="text-xl font-semibold">Impossible de charger les commandes</h1>
          <p className="text-sm">Rafraîchissez la liste ou réessayez dans quelques instants.</p>
          <button
            className="min-h-11 rounded-lg bg-danger px-4 text-sm font-semibold text-white hover:opacity-90"
            onClick={() => reset()}
            type="button"
          >
            Recharger
          </button>
        </div>
      </section>
    </main>
  );
}
