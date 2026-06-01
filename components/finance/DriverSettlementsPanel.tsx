'use client';

import { recordSettlementAction, writeOffShortfallAction } from '@/lib/actions/finance';
import type { SettlementMethod } from '@/lib/finance/cash';
import { formatDateRelative } from '@/lib/format/date';
import { formatMoney } from '@/lib/format/fcfa';
import { cn } from '@/lib/utils';
import { AlertTriangle, CheckCircle2, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useAction } from 'next-safe-action/hooks';
import { useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useMemo, useState } from 'react';

export type FinanceDriverOrder = {
  deliveredAt: string;
  orderId: string;
  orderNumber: string | null;
  outstandingMinor: number;
};

export type FinanceDriverOutstanding = {
  aging: {
    bucket_1_3d: number;
    bucket_gt3d: number;
    bucket_lt1d: number;
  };
  driverId: string;
  driverName: string;
  driverPhone: string;
  orders: FinanceDriverOrder[];
  outstandingMinor: number;
};

export type FinanceShortfall = {
  driverId: string;
  driverName: string;
  id: string;
  reason: string | null;
  shortfallMinor: number;
};

type DriverSettlementsPanelProps = {
  currentRole: string;
  drivers: FinanceDriverOutstanding[];
  shortfalls: FinanceShortfall[];
};

const settlementMethods = ['ESPECES', 'WAVE', 'ORANGE_MONEY', 'FREE_MONEY'] as const;

function parseMinorInput(value: string): number {
  const normalized = value.replace(/\D/g, '');
  return normalized ? Number(normalized) : 0;
}

function agingTone(driver: FinanceDriverOutstanding): 'danger' | 'muted' | 'success' {
  if (driver.aging.bucket_gt3d > 0) {
    return 'danger';
  }

  if (driver.aging.bucket_1_3d > 0) {
    return 'muted';
  }

  return 'success';
}

export function DriverSettlementsPanel({
  currentRole,
  drivers,
  shortfalls,
}: DriverSettlementsPanelProps) {
  const t = useTranslations('finance');
  const router = useRouter();
  const recordSettlement = useAction(recordSettlementAction);
  const writeOffShortfall = useAction(writeOffShortfallAction);
  const [selectedDriverId, setSelectedDriverId] = useState(drivers[0]?.driverId ?? null);
  const [sheetDriverId, setSheetDriverId] = useState<string | null>(null);
  const [clientRequestId, setClientRequestId] = useState('');
  const [amountInput, setAmountInput] = useState('');
  const [method, setMethod] = useState<SettlementMethod>('ESPECES');
  const [note, setNote] = useState('');
  const [writeOffReasonById, setWriteOffReasonById] = useState<Record<string, string>>({});
  const [online, setOnline] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setOnline(navigator.onLine);
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  useEffect(() => {
    if (recordSettlement.result.data?.ok) {
      setNotice(t('settlements.success'));
      closeSheet();
      router.refresh();
    } else if (recordSettlement.result.data?.ok === false) {
      setNotice(t('settlements.error'));
    }
  }, [recordSettlement.result.data, router, t]);

  useEffect(() => {
    if (writeOffShortfall.result.data?.ok) {
      setNotice(t('settlements.writeOffSuccess'));
      router.refresh();
    } else if (writeOffShortfall.result.data?.ok === false) {
      setNotice(t('settlements.error'));
    }
  }, [router, t, writeOffShortfall.result.data]);

  const selectedDriver = useMemo(
    () => drivers.find((driver) => driver.driverId === selectedDriverId) ?? drivers[0] ?? null,
    [drivers, selectedDriverId],
  );
  const sheetDriver = drivers.find((driver) => driver.driverId === sheetDriverId) ?? null;
  const amountMinor = parseMinorInput(amountInput);
  const shortfallMinor = sheetDriver ? Math.max(sheetDriver.outstandingMinor - amountMinor, 0) : 0;

  function openSheet(driverId: string) {
    setSheetDriverId(driverId);
    setClientRequestId(crypto.randomUUID());
    setAmountInput('');
    setMethod('ESPECES');
    setNote('');
    setNotice(null);
  }

  function closeSheet() {
    setSheetDriverId(null);
    setClientRequestId('');
  }

  function submitSettlement(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!sheetDriver || amountMinor <= 0 || !clientRequestId || !online) {
      return;
    }

    recordSettlement.execute({
      amountReceivedMinor: amountMinor,
      clientRequestId,
      driverId: sheetDriver.driverId,
      method,
      note: note.trim() || undefined,
    });
  }

  if (drivers.length === 0) {
    return (
      <section
        className="rounded-lg border border-border bg-surface p-5 text-muted shadow-1"
        id="versements"
      >
        {t('settlements.empty')}
      </section>
    );
  }

  return (
    <section className="space-y-4" id="versements">
      <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
        <div>
          <h2 className="text-xl font-semibold">{t('settlements.title')}</h2>
          <output className="block text-sm text-muted">{notice}</output>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[360px_1fr]">
        <div className="space-y-3">
          {drivers.map((driver) => {
            const tone = agingTone(driver);
            return (
              <button
                className={cn(
                  'min-h-24 w-full rounded-lg border border-border bg-surface p-4 text-left shadow-1 transition hover:-translate-y-0.5 hover:shadow-2 motion-reduce:transition-none',
                  selectedDriver?.driverId === driver.driverId && 'border-accent',
                )}
                key={driver.driverId}
                onClick={() => setSelectedDriverId(driver.driverId)}
                type="button"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold">{driver.driverName}</p>
                    <p className="mt-1 text-sm text-muted">{t('settlements.toPay')}</p>
                  </div>
                  <span
                    className={cn(
                      'inline-flex min-h-8 items-center rounded-full px-3 text-xs font-semibold',
                      tone === 'danger'
                        ? 'bg-danger text-white'
                        : tone === 'success'
                          ? 'bg-success text-white'
                          : 'bg-canvas text-text',
                    )}
                  >
                    {tone === 'danger' ? t('settlements.late') : t('settlements.current')}
                  </span>
                </div>
                <p className="mt-3 font-mono text-2xl font-semibold tabular-nums">
                  {formatMoney(driver.outstandingMinor, 'XOF')}
                </p>
              </button>
            );
          })}
        </div>

        {selectedDriver ? (
          <div className="rounded-lg border border-border bg-surface p-4 shadow-1 md:p-5">
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div>
                <h3 className="text-lg font-semibold">{selectedDriver.driverName}</h3>
                <p className="mt-1 text-sm text-muted">{t('settlements.reliability')}</p>
                <output
                  aria-label={t('settlements.ariaTotal')}
                  className="mt-3 block font-mono text-3xl font-semibold tabular-nums"
                >
                  {formatMoney(selectedDriver.outstandingMinor, 'XOF')}
                </output>
              </div>
              <button
                className="min-h-11 rounded-md bg-accent px-4 text-sm font-semibold text-text hover:bg-accent-hover"
                onClick={() => openSheet(selectedDriver.driverId)}
                type="button"
              >
                {t('settlements.record')}
              </button>
            </div>

            <div className="mt-6 space-y-3">
              <h4 className="text-sm font-semibold">{t('settlements.orders')}</h4>
              {selectedDriver.orders.map((order) => (
                <div
                  className="flex items-center justify-between gap-3 rounded-md border border-border bg-canvas p-3"
                  key={order.orderId}
                >
                  <div>
                    <p className="font-mono text-sm font-semibold tabular-nums">
                      {order.orderNumber ?? order.orderId.slice(0, 8)}
                    </p>
                    <p className="text-xs text-muted">{formatDateRelative(order.deliveredAt)}</p>
                  </div>
                  <p className="font-mono text-sm font-semibold tabular-nums">
                    {formatMoney(order.outstandingMinor, 'XOF')}
                  </p>
                </div>
              ))}
            </div>

            <div className="mt-6 space-y-3">
              <h4 className="text-sm font-semibold">{t('settlements.shortfalls')}</h4>
              {shortfalls.filter((item) => item.driverId === selectedDriver.driverId).length ===
              0 ? (
                <p className="text-sm text-muted">{t('settlements.noShortfalls')}</p>
              ) : (
                shortfalls
                  .filter((item) => item.driverId === selectedDriver.driverId)
                  .map((shortfall) => (
                    <div
                      className="space-y-3 rounded-md border border-danger/30 bg-surface p-3"
                      key={shortfall.id}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <p className="flex items-center gap-2 text-sm font-semibold text-danger">
                          <AlertTriangle aria-hidden="true" className="size-4" />
                          {formatMoney(shortfall.shortfallMinor, 'XOF')}
                        </p>
                        {currentRole === 'owner' ? (
                          <button
                            className="min-h-10 rounded-md border border-border px-3 text-sm font-semibold text-danger"
                            disabled={writeOffShortfall.isExecuting}
                            onClick={() =>
                              writeOffShortfall.execute({
                                reason:
                                  writeOffReasonById[shortfall.id]?.trim() ||
                                  t('settlements.writeOff'),
                                shortfallId: shortfall.id,
                              })
                            }
                            type="button"
                          >
                            {t('settlements.writeOff')}
                          </button>
                        ) : null}
                      </div>
                      {currentRole === 'owner' ? (
                        <input
                          className="h-11 w-full rounded-md border border-border bg-surface px-3 text-sm"
                          onChange={(event) =>
                            setWriteOffReasonById((current) => ({
                              ...current,
                              [shortfall.id]: event.target.value,
                            }))
                          }
                          placeholder={t('settlements.writeOffReason')}
                          value={writeOffReasonById[shortfall.id] ?? ''}
                        />
                      ) : null}
                    </div>
                  ))
              )}
            </div>
          </div>
        ) : null}
      </div>

      {sheetDriver ? (
        <dialog
          className="fixed inset-0 z-50 flex items-end bg-black/30 p-0 md:items-center md:justify-center md:p-6"
          open
        >
          <form
            className="w-full rounded-t-lg border border-border bg-surface p-5 shadow-2 md:max-w-lg md:rounded-lg"
            onSubmit={submitSettlement}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-semibold">{t('settlements.record')}</h3>
                <p className="text-sm text-muted">{sheetDriver.driverName}</p>
              </div>
              <button
                aria-label={t('settlements.close')}
                className="grid min-h-11 min-w-11 place-items-center rounded-md text-muted hover:bg-canvas"
                onClick={closeSheet}
                type="button"
              >
                <X aria-hidden="true" className="size-5" />
              </button>
            </div>

            <div className="mt-5 space-y-4">
              <label className="block space-y-2 text-sm font-medium">
                {t('settlements.amount')}
                <input
                  className="h-12 w-full rounded-md border border-border bg-canvas px-3 font-mono text-lg tabular-nums"
                  inputMode="numeric"
                  onChange={(event) => setAmountInput(event.target.value)}
                  required
                  value={amountInput}
                />
              </label>

              <div className="space-y-2">
                <p className="text-sm font-medium">{t('settlements.method')}</p>
                <div className="grid grid-cols-2 gap-2">
                  {settlementMethods.map((candidate) => (
                    <button
                      className={cn(
                        'min-h-11 rounded-md border border-border px-3 text-sm font-semibold',
                        method === candidate ? 'bg-accent text-text' : 'bg-surface text-muted',
                      )}
                      key={candidate}
                      onClick={() => setMethod(candidate)}
                      type="button"
                    >
                      {t(`methods.${candidate}`)}
                    </button>
                  ))}
                </div>
              </div>

              <label className="block space-y-2 text-sm font-medium">
                {t('settlements.note')}
                <textarea
                  className="min-h-24 w-full rounded-md border border-border bg-canvas px-3 py-2 text-sm"
                  onChange={(event) => setNote(event.target.value)}
                  value={note}
                />
              </label>

              {!online ? <p className="text-sm text-danger">{t('settlements.offline')}</p> : null}
              {shortfallMinor > 0 ? (
                <p className="flex items-center gap-2 rounded-md border border-danger/30 bg-surface p-3 text-sm text-danger">
                  <AlertTriangle aria-hidden="true" className="size-4" />
                  {t('settlements.shortfallWarning', {
                    amount: formatMoney(shortfallMinor, 'XOF'),
                  })}
                </p>
              ) : amountMinor >= sheetDriver.outstandingMinor && amountMinor > 0 ? (
                <p className="flex items-center gap-2 text-sm text-success">
                  <CheckCircle2 aria-hidden="true" className="size-4" />
                  {t('settlements.current')}
                </p>
              ) : null}
            </div>

            <button
              className="mt-5 min-h-12 w-full rounded-md bg-accent px-4 font-semibold text-text hover:bg-accent-hover disabled:opacity-60"
              disabled={!online || amountMinor <= 0 || recordSettlement.isExecuting}
              type="submit"
            >
              {t('settlements.submit')}
            </button>
          </form>
        </dialog>
      ) : null}
    </section>
  );
}
