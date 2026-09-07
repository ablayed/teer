import { getDefaultShopifyAppOrNull, getShopifyAppByLabel } from '@/lib/shopify/apps';

export function getShopifyAppOrNullForEmbedded(label?: string) {
  return label === undefined ? getDefaultShopifyAppOrNull() : getShopifyAppByLabel(label);
}
