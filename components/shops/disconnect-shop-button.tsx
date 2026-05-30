'use client';

import { Button } from '@/components/ui/button';
import { disconnectShopAction } from '@/lib/actions/shopify';
import { useTranslations } from 'next-intl';
import { useAction } from 'next-safe-action/hooks';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

type DisconnectErrorCode = 'merchant_not_found' | 'shop_not_found' | 'disconnect_failed';

const disconnectErrorCodes = [
  'merchant_not_found',
  'shop_not_found',
  'disconnect_failed',
] as const satisfies readonly DisconnectErrorCode[];

function isDisconnectErrorCode(errorCode: string): errorCode is DisconnectErrorCode {
  return disconnectErrorCodes.includes(errorCode as DisconnectErrorCode);
}

export function DisconnectShopButton() {
  const t = useTranslations('shops');
  const router = useRouter();
  const disconnectShop = useAction(disconnectShopAction);
  const result = disconnectShop.result.data;
  const errorMessage =
    result?.ok === false
      ? isDisconnectErrorCode(result.errorCode)
        ? t(`disconnect.errors.${result.errorCode}`)
        : t('disconnect.errors.disconnect_failed')
      : null;

  useEffect(() => {
    if (result?.ok) {
      router.refresh();
    }
  }, [result, router]);

  function onDisconnect() {
    if (window.confirm(t('disconnect.confirm'))) {
      disconnectShop.execute();
    }
  }

  return (
    <div className="space-y-3">
      <Button
        disabled={disconnectShop.isExecuting}
        onClick={onDisconnect}
        type="button"
        variant="ghost"
      >
        {t('disconnect.submit')}
      </Button>

      {errorMessage ? (
        <p className="text-sm text-danger" role="alert">
          {errorMessage}
        </p>
      ) : null}
    </div>
  );
}
