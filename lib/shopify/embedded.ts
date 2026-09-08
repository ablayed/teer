import { getShopifyAppByLabel } from '@/lib/shopify/apps';

// Alias historique explicite : `/shopify/embedded` (sans segment de label) reste Teer Dev,
// rétrocompatibilité nommée — jamais un "défaut" implicite du registre (`getDefaultShopifyAppOrNull`
// dépend de l'ordre d'enregistrement des apps, pas d'une décision de routage assumée ici).
const HISTORICAL_UNLABELLED_ALIAS = 'teer-dev';

export function getShopifyAppOrNullForEmbedded(label?: string) {
  return getShopifyAppByLabel(label ?? HISTORICAL_UNLABELLED_ALIAS);
}
