'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';

function normalizeShopDomain(raw: string): string {
  const withoutProtocol = raw.trim().replace(/^https?:\/\//i, '');
  const firstSegment = withoutProtocol.split('/')[0]?.trim().toLowerCase() ?? '';

  if (!firstSegment) {
    return '';
  }

  return firstSegment.endsWith('.myshopify.com') ? firstSegment : `${firstSegment}.myshopify.com`;
}

function isValidShopDomain(shop: string): boolean {
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop);
}

export function ConnectShopForm() {
  const t = useTranslations('shops');
  const router = useRouter();
  const [shop, setShop] = useState('');
  const [error, setError] = useState<string | null>(null);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const normalizedShop = normalizeShopDomain(shop);

    if (!isValidShopDomain(normalizedShop)) {
      setError(t('errors.invalid_shop'));
      return;
    }

    router.push(`/api/shopify/install?shop=${encodeURIComponent(normalizedShop)}`);
  }

  return (
    <form className="space-y-4" onSubmit={onSubmit}>
      <div className="space-y-2">
        <Label htmlFor="shop-domain">{t('connect.domainLabel')}</Label>
        <Input
          autoCapitalize="none"
          autoCorrect="off"
          id="shop-domain"
          inputMode="url"
          name="shop"
          onChange={(event) => setShop(event.target.value)}
          placeholder={t('connect.domainPlaceholder')}
          required
          value={shop}
        />
      </div>

      {error ? (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      ) : null}

      <Button className="min-h-12 w-full sm:w-auto" type="submit">
        {t('connect.submit')}
      </Button>
    </form>
  );
}
