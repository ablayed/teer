import { decryptToken } from '@/lib/shopify/crypto';
import { type ShopStatusInput, shopStatus } from '@/lib/shopify/shop-status';

export type NonEmbeddedInstallShop = ShopStatusInput & {
  shopifyClientId: string | null;
};

export function hasUsableCredentialsForApp(
  shop: NonEmbeddedInstallShop | null,
  expectedClientId: string,
): boolean {
  if (
    !shop ||
    shop.shopifyClientId !== expectedClientId ||
    shop.status !== 'active' ||
    shop.storeKind !== 'shopify' ||
    shopStatus(shop).status !== 'connected' ||
    !shop.accessTokenEncrypted
  ) {
    return false;
  }

  try {
    const accessExpiresAt = shop.accessTokenExpiresAt
      ? Date.parse(shop.accessTokenExpiresAt)
      : null;
    const refreshExpiresAt = shop.refreshTokenExpiresAt
      ? Date.parse(shop.refreshTokenExpiresAt)
      : null;
    if (
      (accessExpiresAt !== null && !Number.isFinite(accessExpiresAt)) ||
      (refreshExpiresAt !== null && !Number.isFinite(refreshExpiresAt))
    ) {
      return false;
    }

    decryptToken(shop.accessTokenEncrypted);
    const accessExpired = accessExpiresAt !== null && accessExpiresAt <= Date.now();
    if (accessExpired) {
      if (
        !shop.refreshTokenEncrypted ||
        (refreshExpiresAt !== null && refreshExpiresAt <= Date.now())
      ) {
        return false;
      }
      decryptToken(shop.refreshTokenEncrypted);
    }
    return true;
  } catch {
    return false;
  }
}
