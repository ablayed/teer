'use client';

import { motion } from 'framer-motion';
import { CheckCircle2, Phone } from 'lucide-react';
import Link from 'next/link';
import React from 'react';

export type NextActionViewItem = {
  id: string;
  href: string;
  orderNumber: string;
  customerName: string;
  phone: string;
  phoneRaw: string | null;
  age: string;
  total: string;
};

type NextActionsListMotionProps = {
  emptyLabel: string;
  items: NextActionViewItem[];
};

export function NextActionsListMotion({ emptyLabel, items }: NextActionsListMotionProps) {
  if (items.length === 0) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-success/25 bg-success-subtle p-4 text-success">
        <CheckCircle2 aria-hidden="true" className="size-5 shrink-0" />
        <p className="text-sm font-medium">{emptyLabel}</p>
      </div>
    );
  }

  return (
    <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface shadow-1">
      {items.map((item, index) => (
        <motion.div
          animate={{ opacity: 1, y: 0 }}
          initial={{ opacity: 0, y: 6 }}
          key={item.id}
          transition={{ delay: index * 0.05, duration: 0.2, ease: [0.2, 0, 0, 1] }}
        >
          <div className="grid gap-3 p-4 transition hover:bg-canvas/60 sm:grid-cols-[1fr_auto_auto] sm:items-center">
            <Link className="min-w-0" href={item.href}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <p className="font-mono text-sm font-semibold text-text">{item.orderNumber}</p>
                <p className="truncate text-sm font-medium text-text">{item.customerName}</p>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                <span>{item.phone}</span>
                <span>{item.age}</span>
              </div>
            </Link>
            <p className="font-mono text-sm font-semibold text-text sm:text-right">{item.total}</p>
            {item.phoneRaw ? (
              <a
                aria-label={`Appeler ${item.customerName}`}
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-accent px-3 text-sm font-semibold text-accent-ink transition hover:bg-accent-hover"
                href={`tel:${item.phoneRaw.replace(/\s/g, '')}`}
              >
                <Phone aria-hidden="true" className="size-4" />
                Appeler
              </a>
            ) : null}
          </div>
        </motion.div>
      ))}
    </div>
  );
}
