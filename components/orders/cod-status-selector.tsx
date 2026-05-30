'use client';

import { Button } from '@/components/ui/button';
import { updateCodStatusAction } from '@/lib/actions/orders';
import { type CodStatus, codStatuses } from '@/lib/orders/status';
import { useTranslations } from 'next-intl';
import { useAction } from 'next-safe-action/hooks';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

type CodStatusSelectorProps = {
  currentStatus: CodStatus;
  orderId: string;
};

type UpdateErrorCode = 'merchant_not_found' | 'order_not_found' | 'update_failed' | 'audit_failed';

const updateErrorCodes = [
  'merchant_not_found',
  'order_not_found',
  'update_failed',
  'audit_failed',
] as const satisfies readonly UpdateErrorCode[];

function isUpdateErrorCode(errorCode: string): errorCode is UpdateErrorCode {
  return updateErrorCodes.includes(errorCode as UpdateErrorCode);
}

export function CodStatusSelector({ currentStatus, orderId }: CodStatusSelectorProps) {
  const t = useTranslations('orders');
  const router = useRouter();
  const updateStatus = useAction(updateCodStatusAction);
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'error'; message: string } | null>(
    null,
  );
  const result = updateStatus.result.data;
  const validationError = updateStatus.result.validationErrors ? t('errors.generic') : null;

  const actionError = useMemo(() => {
    if (!result || result.ok) {
      return null;
    }

    return isUpdateErrorCode(result.errorCode)
      ? t(`errors.${result.errorCode}`)
      : t('errors.generic');
  }, [result, t]);

  useEffect(() => {
    if (result?.ok) {
      setFeedback({ tone: 'success', message: t('detail.success') });
      router.refresh();
      return;
    }

    const errorMessage = actionError ?? validationError;

    if (errorMessage) {
      setFeedback({ tone: 'error', message: errorMessage });
    }
  }, [actionError, result, router, t, validationError]);

  function onChangeStatus(codStatus: CodStatus) {
    setFeedback(null);
    updateStatus.execute({ orderId, codStatus });
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {codStatuses.map((status) => (
          <Button
            className="min-h-12 justify-start"
            disabled={status === currentStatus || updateStatus.isExecuting}
            key={status}
            onClick={() => onChangeStatus(status)}
            type="button"
            variant={status === currentStatus ? 'primary' : 'ghost'}
          >
            {t(`actions.${status}`)}
          </Button>
        ))}
      </div>

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
