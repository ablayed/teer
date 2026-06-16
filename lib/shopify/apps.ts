// Registre multi-app Shopify — singleton lié aux env vars (serveur uniquement).
//
// Le cœur pur (factory + types) vit dans lib/shopify/app-registry.ts (importable en test sans env).
// Ici on construit le registre une fois au chargement depuis les credentials des apps connues :
//   - Teer Dev   : SHOPIFY_API_KEY / SHOPIFY_API_SECRET (app publique, par défaut, rétrocompat) ;
//   - Teer Pilote: SHOPIFY_PILOTE_API_KEY / SHOPIFY_PILOTE_API_SECRET (app custom).
//   - Teer Marchand: SHOPIFY_MARCHAND_API_KEY / SHOPIFY_MARCHAND_API_SECRET (app custom pilote).
//   - Teer Koba   : SHOPIFY_KOBA_API_KEY / SHOPIFY_KOBA_API_SECRET (app custom créée dans l'org
//     du marchand, pour un store hors de l'org Tëër — testing).
// Les secrets ne sortent jamais d'ici (jamais en NEXT_PUBLIC_, jamais loggés).

import { env } from '@/lib/env';
import { type ShopifyAppConfig, createShopifyAppRegistry } from '@/lib/shopify/app-registry';

export type {
  ShopifyAppConfig,
  ShopifyAppLabel,
  ShopifyAppRegistry,
  ShopifyAppEnvSource,
} from '@/lib/shopify/app-registry';
export { createShopifyAppRegistry } from '@/lib/shopify/app-registry';

// Singleton construit depuis les env vars (lu une fois au chargement du module).
// Teer Dev en premier = app par défaut (rétrocompat).
const REGISTRY = createShopifyAppRegistry([
  { label: 'teer-dev', clientId: env.SHOPIFY_API_KEY, clientSecret: env.SHOPIFY_API_SECRET },
  {
    label: 'teer-pilote',
    clientId: env.SHOPIFY_PILOTE_API_KEY,
    clientSecret: env.SHOPIFY_PILOTE_API_SECRET,
  },
  {
    label: 'teer-marchand',
    clientId: env.SHOPIFY_MARCHAND_API_KEY,
    clientSecret: env.SHOPIFY_MARCHAND_API_SECRET,
  },
  {
    label: 'teer-koba',
    clientId: env.SHOPIFY_KOBA_API_KEY,
    clientSecret: env.SHOPIFY_KOBA_API_SECRET,
  },
]);

// Renvoie la config de l'app correspondant au client_id, ou null si inconnu/non enregistré.
export function getShopifyAppByClientId(
  clientId: string | null | undefined,
): ShopifyAppConfig | null {
  return REGISTRY.getByClientId(clientId);
}

// App par défaut (Teer Dev) : rétrocompatibilité pour l'install publique et le fallback.
// Lève si aucune app n'est configurée (déploiement sans credentials Shopify).
export function getDefaultShopifyApp(): ShopifyAppConfig {
  const app = REGISTRY.getDefault();
  if (!app) {
    throw new Error('Aucune app Shopify configurée (SHOPIFY_API_KEY/SECRET manquants)');
  }
  return app;
}

// Variante non levante : utile dans les routes qui veulent renvoyer une erreur HTTP propre.
export function getDefaultShopifyAppOrNull(): ShopifyAppConfig | null {
  return REGISTRY.getDefault();
}

// Toutes les apps enregistrées (pour itérer, ex. réconciliation/credentials sortants par boutique).
export function getRegisteredShopifyApps(): ShopifyAppConfig[] {
  return REGISTRY.all();
}

// Résout les credentials d'une boutique à partir de son shop.shopify_client_id, avec fallback
// sur l'app par défaut (boutiques antérieures au multi-app / client_id inconnu).
export function getShopifyAppForShop(
  shopifyClientId: string | null | undefined,
): ShopifyAppConfig | null {
  return getShopifyAppByClientId(shopifyClientId) ?? getDefaultShopifyAppOrNull();
}
