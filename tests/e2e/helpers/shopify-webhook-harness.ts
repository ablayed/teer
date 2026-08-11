import { createHash } from 'node:crypto';

// Clé déterministe et synthétique, utilisée uniquement quand le harness webhook est explicitement
// activé. Elle permet au serveur Next et au signeur Playwright de partager la même configuration
// sans lire ni dépendre d'une clé Shopify locale.
export const SHOPIFY_E2E_CLIENT_ID = 's2-e2e-shopify-app';
export const SHOPIFY_E2E_HMAC_SECRET = createHash('sha256')
  .update('teer-s2-shopify-webhook-harness')
  .digest('hex');
