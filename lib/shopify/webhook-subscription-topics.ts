// SHOPIFY-WEBHOOKS-PER-SHOP-1B — topics des abonnements webhook Shopify créés PAR BOUTIQUE.
//
// Source unique de la liste : scripts/lib/webhook-subscription-plan.mjs la réexporte, et la
// réconciliation applicative (lib/shopify/webhook-subscription-reconcile.ts) la consomme.
//
// Module sans aucun import : chargeable tel quel par le Node natif (scripts de diagnostic), sans
// résolution d'alias.
//
// rest = forme historique (webhook_event.topic, ingestion_event.topic) ; graphql = valeur de
// l'enum WebhookSubscriptionTopic de l'Admin API.
export type ShopifyWebhookTopic = { readonly rest: string; readonly graphql: string };

// Les huit topics métier, par boutique sur l'URL opaque.
export const ADMIN_API_TOPICS: readonly ShopifyWebhookTopic[] = [
  { rest: 'orders/create', graphql: 'ORDERS_CREATE' },
  { rest: 'orders/updated', graphql: 'ORDERS_UPDATED' },
  { rest: 'orders/cancelled', graphql: 'ORDERS_CANCELLED' },
  { rest: 'orders/fulfilled', graphql: 'ORDERS_FULFILLED' },
  { rest: 'products/create', graphql: 'PRODUCTS_CREATE' },
  { rest: 'products/update', graphql: 'PRODUCTS_UPDATE' },
  { rest: 'refunds/create', graphql: 'REFUNDS_CREATE' },
  { rest: 'bulk_operations/finish', graphql: 'BULK_OPERATIONS_FINISH' },
];

// E0 — `app/uninstalled` est AUSSI souscrit par boutique, sur l'URL opaque, pour que la
// désinstallation soit résolue par le jeton d'URL et non par un en-tête non signé (D20b).
//
// Tant que l'abonnement global du TOML n'est pas retiré (E11, hors de ce lot), chaque
// désinstallation produit donc DEUX livraisons, de `Webhook-Id` distincts : une sur l'endpoint
// historique, une sur l'URL opaque. C'est assumé, et c'est la primitive ordonnée
// (`uninstall_shopify_pending_or_shop_ordered`, 0161) qui rend la seconde sans effet.
export const PER_SHOP_UNINSTALL_TOPIC: ShopifyWebhookTopic = {
  rest: 'app/uninstalled',
  graphql: 'APP_UNINSTALLED',
};

// Les neuf abonnements attendus pour chaque boutique Shopify connectée.
export const PER_SHOP_SUBSCRIPTION_TOPICS: readonly ShopifyWebhookTopic[] = [
  ...ADMIN_API_TOPICS,
  PER_SHOP_UNINSTALL_TOPIC,
];
