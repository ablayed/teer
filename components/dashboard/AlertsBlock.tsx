import { Card } from '@/components/ui/card';
import type { DashboardAlert } from '@/lib/actions/dashboard';
import { cn } from '@/lib/utils';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';

type AlertsBlockProps = {
  emptyLabel: string;
  items: DashboardAlert[];
  title: string;
};

export function AlertsBlock({ emptyLabel, items, title }: AlertsBlockProps) {
  return (
    <Card className="rounded-lg" padding="lg">
      <h2 className="mb-5 text-[15px] font-semibold text-text">{title}</h2>
      {items.length === 0 ? (
        <div className="flex items-center gap-3 rounded-md border border-success/25 bg-success-subtle p-4 text-success">
          <CheckCircle2 aria-hidden="true" className="size-5 shrink-0" />
          <p className="text-sm font-medium">{emptyLabel}</p>
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((item) => (
            <div
              className={cn(
                'flex gap-3 rounded-md border p-4',
                item.tone === 'danger'
                  ? 'border-danger/25 bg-danger-subtle text-danger'
                  : 'border-accent/25 bg-accent-subtle text-text',
              )}
              key={item.id}
            >
              <AlertTriangle aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
              <div>
                <p className="text-sm font-semibold">{item.title}</p>
                <p className="mt-1 text-sm">{item.value}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
