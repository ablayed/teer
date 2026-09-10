'use client';

import { commitCsvOrderImportAction, previewCsvOrderImportAction } from '@/lib/actions/orders';
import { useAction } from 'next-safe-action/hooks';
import { useEffect, useState } from 'react';

type PreviewOrder = {
  orderKey: string;
  rowNumbers: readonly number[];
  status: 'ready' | 'invalid' | 'already_imported';
  errors: readonly string[];
};

export function CsvOrderImport() {
  const preview = useAction(previewCsvOrderImportAction);
  const commit = useAction(commitCsvOrderImportAction);
  const [isOpen, setIsOpen] = useState(false);
  const [csvText, setCsvText] = useState<string | null>(null);
  const [orders, setOrders] = useState<PreviewOrder[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const result = preview.result.data;
    if (!result) return;
    if (!result.ok) {
      setMessage('La boutique active est introuvable.');
      return;
    }
    setOrders(result.orders);
    setMessage(null);
  }, [preview.result.data]);

  useEffect(() => {
    const result = commit.result.data;
    if (!result) return;
    if (!result.ok) {
      setMessage('La boutique active est introuvable.');
      return;
    }
    const imported = result.results.filter((item) => item.status === 'imported').length;
    const skipped = result.results.filter((item) => item.status === 'already_imported').length;
    setMessage(`${imported} commande(s) importée(s), ${skipped} déjà importée(s).`);
    setOrders((current) =>
      current.map((item) =>
        result.results.some(
          (resultItem) => resultItem.orderKey === item.orderKey && resultItem.status === 'imported',
        )
          ? { ...item, status: 'already_imported', errors: ['Commande déjà importée.'] }
          : item,
      ),
    );
  }, [commit.result.data]);

  async function selectFile(file: File | undefined) {
    if (!file) return;
    const text = await file.text();
    setCsvText(text);
    setOrders([]);
    setMessage(null);
    preview.execute({ csvText: text });
  }

  const readyCount = orders.filter((item) => item.status === 'ready').length;

  return (
    <div className="w-full max-w-2xl rounded-lg border border-border bg-surface p-4 shadow-1">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-semibold">Importer des commandes CSV</p>
          <p className="text-sm text-muted">
            Une ligne représente une ligne de commande. Les lignes partageant un order_key sont
            importées ensemble.
          </p>
        </div>
        <button
          className="min-h-12 rounded-lg border border-border px-4 text-sm font-semibold hover:bg-canvas"
          onClick={() => setIsOpen((value) => !value)}
          type="button"
        >
          {isOpen ? 'Fermer' : 'Importer un CSV'}
        </button>
      </div>

      {isOpen ? (
        <div className="mt-4 space-y-4">
          <label className="block space-y-2">
            <span className="text-sm font-medium">Fichier CSV</span>
            <input
              accept=".csv,text/csv"
              className="block w-full text-sm"
              onChange={(event) => void selectFile(event.target.files?.[0])}
              type="file"
            />
          </label>
          <p className="text-xs text-muted">
            Colonnes requises : order_key, title, quantity, unit_amount, customer_name, phone. Le
            fichier n’est pas conservé.
          </p>

          {orders.length > 0 ? (
            <div className="space-y-2" aria-live="polite">
              <p className="text-sm font-medium">
                Prévisualisation : {readyCount} commande(s) prête(s) à importer.
              </p>
              <ul className="max-h-56 space-y-2 overflow-auto text-sm">
                {orders.map((order) => (
                  <li
                    className="rounded border border-border p-2"
                    key={`${order.orderKey}-${order.rowNumbers.join('-')}`}
                  >
                    <span className="font-medium">
                      {order.orderKey || 'Commande sans identifiant'}
                    </span>{' '}
                    <span className="text-muted">
                      (lignes {order.rowNumbers.join(', ') || '—'})
                    </span>
                    <p className={order.status === 'ready' ? 'text-success' : 'text-danger'}>
                      {order.status === 'ready'
                        ? 'Prête à importer.'
                        : order.status === 'already_imported'
                          ? 'Déjà importée.'
                          : order.errors.join(' ')}
                    </p>
                  </li>
                ))}
              </ul>
              <button
                className="min-h-12 rounded-lg bg-accent px-4 text-sm font-semibold text-[#111] disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!csvText || readyCount === 0 || commit.isExecuting}
                onClick={() => csvText && commit.execute({ csvText })}
                type="button"
              >
                {commit.isExecuting ? 'Import en cours…' : 'Confirmer l’import'}
              </button>
            </div>
          ) : null}
          {message ? <output className="text-sm text-muted">{message}</output> : null}
        </div>
      ) : null}
    </div>
  );
}
