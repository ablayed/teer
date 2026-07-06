'use client';

import type { StockShortageRow } from '@/lib/orders/assignment-stock-check';
import { useTranslations } from 'next-intl';

type StockShortageWarningProps = {
  shortages: StockShortageRow[];
  checkFailed: boolean;
};

// Lot 2 / PR 3 (AssignmentDetailsDialog) + Lot 2 / PR 4 (TransitionDialog, chemin agent) —
// bandeau informatif partagé, jamais bloquant. Extrait en composant pur pour éviter de
// dupliquer le markup entre les deux dialogs (même style, mêmes clés i18n).
export function StockShortageWarning({ shortages, checkFailed }: StockShortageWarningProps) {
  const t = useTranslations('orders.assignment.stockWarning');

  if (shortages.length === 0 && !checkFailed) {
    return null;
  }

  return (
    <>
      {shortages.length > 0 ? (
        <output className="block space-y-1 rounded-md bg-warning/15 p-3">
          <p className="text-sm font-medium text-warning-foreground">{t('title')}</p>
          <ul className="space-y-0.5 text-sm text-warning-foreground">
            {shortages.map((shortage) => (
              <li key={shortage.productId}>
                {t('item', { product: shortage.title, qty: shortage.missingQty })}
              </li>
            ))}
          </ul>
        </output>
      ) : null}

      {checkFailed ? <p className="text-sm text-warning-foreground">{t('checkFailed')}</p> : null}
    </>
  );
}
