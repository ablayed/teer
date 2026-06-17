import type { SettlementHistoryRow } from '@/lib/actions/drivers';
import { formatDateTime } from '@/lib/format/date';
import { formatMoney } from '@/lib/format/fcfa';

const METHOD_LABELS: Record<string, string> = {
  ESPECES: 'Espèces',
  WAVE: 'Wave',
  ORANGE_MONEY: 'Orange Money',
  FREE_MONEY: 'Free Money',
};

type Props = {
  rows: SettlementHistoryRow[];
  // true sur la vue globale (colonne Livreur), false sur l'historique d'un livreur.
  showDriver?: boolean;
  emptyLabel?: string;
};

// Tableau présentationnel (pur) partagé par l'historique par livreur (client, dans
// DriverCashPanel) ET la vue versements globaux (RSC, page Livreurs). Affiche date +
// heure (Africa/Dakar), montant via formatMoney (les reprises négatives 0056 restent
// lisibles avec leur signe), moyen et auteur.
export function SettlementHistoryTable({ rows, showDriver = false, emptyLabel }: Props) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted">{emptyLabel ?? 'Aucun versement enregistré.'}</p>;
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-surface text-left">
            <th className="px-4 py-3 font-medium">Date</th>
            {showDriver ? <th className="px-4 py-3 font-medium">Livreur</th> : null}
            <th className="px-4 py-3 text-right font-medium">Montant</th>
            <th className="px-4 py-3 font-medium">Moyen</th>
            <th className="px-4 py-3 font-medium">Auteur</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr className="border-b border-border last:border-0" key={row.id}>
              <td className="px-4 py-3 text-muted">{formatDateTime(row.settledAt)}</td>
              {showDriver ? <td className="px-4 py-3 font-medium">{row.driverName}</td> : null}
              <td
                className={`px-4 py-3 text-right font-mono tabular-nums ${
                  row.amountMinor < 0 ? 'text-danger' : ''
                }`}
              >
                {formatMoney(row.amountMinor, 'XOF')}
              </td>
              <td className="px-4 py-3">{METHOD_LABELS[row.method] ?? row.method}</td>
              <td className="px-4 py-3 text-muted">{row.authorName}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
