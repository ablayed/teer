// SHOPIFY-WEBHOOKS-PER-SHOP-1B — origine publique des webhooks (WEBHOOK_PUBLIC_BASE_URL).
//
// Lue À L'APPEL, jamais au chargement, et hors de lib/env : les modules qui s'en servent
// (effets après connexion, réconciliation) doivent rester importables sans l'environnement
// complet, comme lib/shopify/crypto.ts pour sa clé.
//
// Aucune valeur par défaut, aucun repli sur NEXT_PUBLIC_APP_URL : absente ou inutilisable, la
// réconciliation rend un refus nommé (`base_url_unavailable`) et n'enregistre rien chez Shopify.
// La validation de la forme est faite par `parseWebhookPublicBaseUrl`
// (lib/shopify/webhook-subscription-inventory.ts).
export function readWebhookPublicBaseUrl(): string | null {
  return process.env.WEBHOOK_PUBLIC_BASE_URL || null;
}
