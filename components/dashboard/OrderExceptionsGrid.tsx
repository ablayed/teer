import { ArrowRight } from 'lucide-react';
import Link from 'next/link';

type ExceptionRow = {
  count: number;
  href: string;
  label: string;
};

type ExceptionCard = {
  rows: ExceptionRow[];
  title: string;
};

type OrderExceptionsGridProps =
  | {
      cards: ExceptionCard[];
      status: 'ready';
      title: string;
    }
  | {
      errorLabel: string;
      groupTitles: string[];
      status: 'error';
      title: string;
    };

export function OrderExceptionsGrid(props: OrderExceptionsGridProps) {
  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">{props.title}</h2>
      </div>

      <div className="grid gap-4 xl:grid-cols-4">
        {props.status === 'error'
          ? props.groupTitles.map((groupTitle) => (
              <article
                className="rounded-lg border border-border bg-surface p-4 shadow-1"
                key={groupTitle}
              >
                <h3 className="text-sm font-semibold text-muted">{groupTitle}</h3>
                <p className="mt-4 rounded-md border border-dashed border-danger/20 bg-danger-subtle p-3 text-sm font-medium text-danger">
                  {props.errorLabel}
                </p>
              </article>
            ))
          : props.cards.map((card) => (
              <article
                className="rounded-lg border border-border bg-surface p-4 shadow-1"
                key={card.title}
              >
                <h3 className="text-sm font-semibold text-muted">{card.title}</h3>
                <div className="mt-4 space-y-3">
                  {card.rows.map((row) => (
                    <Link
                      className="flex min-h-11 items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-sm hover:bg-canvas"
                      href={row.href}
                      key={`${card.title}-${row.label}`}
                    >
                      <span>{row.label}</span>
                      <span className="flex items-center gap-2 font-mono font-semibold tabular-nums">
                        {row.count}
                        <ArrowRight aria-hidden="true" className="size-4 text-muted" />
                      </span>
                    </Link>
                  ))}
                </div>
              </article>
            ))}
      </div>
    </section>
  );
}
