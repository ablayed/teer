'use client';

import { Button } from '@/components/ui/button';
import { syncOrdersAction } from '@/lib/actions/shopify';
import { RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useAction } from 'next-safe-action/hooks';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

type SyncOrdersButtonProps = {
  hasShop: boolean;
};

type SyncErrorCode = 'no_shop' | 'sync_failed' | 'token_error';

const syncErrorCodes = [
  'no_shop',
  'sync_failed',
  'token_error',
] as const satisfies readonly SyncErrorCode[];

function isSyncErrorCode(errorCode: string): errorCode is SyncErrorCode {
  return syncErrorCodes.includes(errorCode as SyncErrorCode);
}

export function SyncOrdersButton({ hasShop }: SyncOrdersButtonProps) {
  const t = useTranslations('orders');
  const router = useRouter();
  const syncOrders = useAction(syncOrdersAction);
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'error'; message: string } | null>(
    null,
  );
  const result = syncOrders.result.data;
  const validationError = syncOrders.result.validationErrors ? t('errors.generic') : null;

  const actionError = useMemo(() => {
    if (!result || result.ok) {
      return null;
    }

    return isSyncErrorCode(result.errorCode)
      ? t(`errors.${result.errorCode}`)
      : t('errors.generic');
  }, [result, t]);

  useEffect(() => {
    if (result?.ok) {
      setFeedback({
        tone: 'success',
        message: t('sync.success', { count: result.syncedCount }),
      });
      router.refresh();
      return;
    }

    const errorMessage = actionError ?? validationError;

    if (errorMessage) {
      setFeedback({ tone: 'error', message: errorMessage });
    }
  }, [actionError, result, router, t, validationError]);

  function onSync() {
    setFeedback(null);
    syncOrders.execute();
  }

  return (
    <div className="space-y-2">
      <Button
        aria-label={t('sync.submit')}
        className="min-h-12 w-full sm:w-auto"
        disabled={!hasShop || syncOrders.isExecuting}
        onClick={onSync}
        title={!hasShop ? t('sync.disabled') : undefined}
        type="button"
      >
        <RefreshCw
          aria-hidden="true"
          className={`size-4 ${syncOrders.isExecuting ? 'animate-spin' : ''}`}
        />
        {syncOrders.isExecuting ? t('sync.loading') : t('sync.submit')}
      </Button>

      {feedback ? (
        <p
          className={`text-sm font-medium ${feedback.tone === 'success' ? 'text-success' : 'text-danger'}`}
          role={feedback.tone === 'error' ? 'alert' : 'status'}
        >
          {feedback.message}
        </p>
      ) : null}
    </div>
  );
}
