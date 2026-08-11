import { getDefaultShopifyAppOrNull } from '@/lib/shopify/apps';

export function getShopifyAppOrNullForEmbedded() {
  return getDefaultShopifyAppOrNull();
}
