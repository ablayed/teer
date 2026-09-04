import type { ShopFilterOption } from '@/lib/shops/shop-filter';
import Link from 'next/link';

type ShopFilterSelectorProps = {
  allLabel: string;
  ariaLabel: string;
  label: string;
  pathname: string;
  searchParams: Record<string, string | undefined>;
  selectedShopId: string | null;
  shops: ShopFilterOption[];
};

function hrefForShop({
  pathname,
  searchParams,
  shopId,
}: {
  pathname: string;
  searchParams: Record<string, string | undefined>;
  shopId: string | null;
}): string {
  const next = new URLSearchParams();

  for (const [key, value] of Object.entries(searchParams)) {
    if (value && key !== 'shop') {
      next.set(key, value);
    }
  }

  next.set('shop', shopId ?? 'all');

  return `${pathname}?${next.toString()}`;
}

export function ShopFilterSelector({
  allLabel,
  ariaLabel,
  label,
  pathname,
  searchParams,
  selectedShopId,
  shops,
}: ShopFilterSelectorProps) {
  if (shops.length <= 1) {
    return null;
  }

  const itemClass = (active: boolean) =>
    `grid min-h-12 place-items-center rounded-md px-3 text-sm font-medium ${
      active ? 'bg-accent text-text' : 'text-muted hover:text-text'
    }`;

  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted">{label}</p>
      <nav
        aria-label={ariaLabel}
        className="flex flex-wrap gap-1 rounded-lg border border-border bg-surface p-1 shadow-1"
      >
        <Link
          aria-current={selectedShopId === null ? 'true' : undefined}
          className={itemClass(selectedShopId === null)}
          href={hrefForShop({ pathname, searchParams, shopId: null })}
        >
          {allLabel}
        </Link>
        {shops.map((shop) => (
          <Link
            aria-current={selectedShopId === shop.id ? 'true' : undefined}
            className={itemClass(selectedShopId === shop.id)}
            href={hrefForShop({ pathname, searchParams, shopId: shop.id })}
            key={shop.id}
          >
            {shop.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
