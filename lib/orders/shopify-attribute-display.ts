// Les attributs Shopify restent stockés bruts : cette règle ne concerne que leur affichage
// opérationnel, afin d'écarter le tracking, les jetons techniques et les données personnelles.
export type ShopifyAttributeForDisplay = {
  key: string;
};

export function isShopifyAttributeDisplayable({ key }: ShopifyAttributeForDisplay): boolean {
  const normalizedKey = key.trim().toLowerCase();

  return !(
    normalizedKey === '_' ||
    normalizedKey === 'ip address' ||
    normalizedKey === 'ip_address' ||
    normalizedKey.startsWith('utm_') ||
    normalizedKey.includes('token') ||
    normalizedKey.includes('url')
  );
}

export function filterShopifyAttributesForDisplay<T extends ShopifyAttributeForDisplay>(
  attributes: T[],
): T[] {
  return attributes.filter(isShopifyAttributeDisplayable);
}
