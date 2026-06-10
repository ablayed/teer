// Registre multi-app Shopify — cœur PUR et testable (n'importe AUCUN env).
//
// Tëër héberge DEUX apps Shopify sur un seul déploiement :
//   - Teer Dev   : app publique (credentials historiques SHOPIFY_API_KEY / SHOPIFY_API_SECRET) ;
//   - Teer Pilote: app custom (SHOPIFY_PILOTE_API_KEY / SHOPIFY_PILOTE_API_SECRET).
// Le routage (install OAuth, vérif HMAC webhooks, credentials sortants) se fait sur le `client_id`.
//
// Le singleton lié aux env vars vit dans lib/shopify/apps.ts ; ce module reste importable en test
// sans déclencher la validation Zod de lib/env.

import { SHOPIFY_REQUIRED_SCOPES } from '@/lib/shopify/oauth';

export type ShopifyAppLabel = 'teer-dev' | 'teer-pilote';

export type ShopifyAppConfig = {
  clientId: string;
  clientSecret: string;
  scopes: string;
  label: ShopifyAppLabel;
};

// Une entrée de configuration brute (issue des env vars). clientId/secret peuvent manquer.
export type ShopifyAppEnvSource = {
  label: ShopifyAppLabel;
  clientId: string | undefined;
  clientSecret: string | undefined;
};

// Scopes communs aux deux apps (read_orders,read_customers,read_products).
const DEFAULT_SCOPES = SHOPIFY_REQUIRED_SCOPES.join(',');

export type ShopifyAppRegistry = {
  // Config de l'app correspondant au client_id, ou null si inconnu/non enregistré.
  getByClientId(clientId: string | null | undefined): ShopifyAppConfig | null;
  // App par défaut (Teer Dev si présente, sinon la première enregistrée), ou null si aucune.
  getDefault(): ShopifyAppConfig | null;
  // Toutes les apps enregistrées (pour itérer, ex. credentials sortants par boutique).
  all(): ShopifyAppConfig[];
};

// Factory PURE : construit un registre depuis une liste de sources d'env. Une app dont clientId
// OU clientSecret manque n'est PAS enregistrée ; une config partielle (un seul des deux) est
// signalée sans faire crasher le boot. L'ordre des sources = priorité du défaut (Teer Dev en
// premier → app par défaut, rétrocompat).
export function createShopifyAppRegistry(
  sources: readonly ShopifyAppEnvSource[],
): ShopifyAppRegistry {
  const byClientId = new Map<string, ShopifyAppConfig>();
  const ordered: ShopifyAppConfig[] = [];

  for (const source of sources) {
    if (!source.clientId || !source.clientSecret) {
      if (source.clientId || source.clientSecret) {
        // biome-ignore lint/suspicious/noConsole: signal de configuration multi-app au boot.
        console.warn(`[shopify-apps] app "${source.label}" ignorée : credentials incomplets`);
      }
      continue;
    }

    const config: ShopifyAppConfig = {
      clientId: source.clientId,
      clientSecret: source.clientSecret,
      scopes: DEFAULT_SCOPES,
      label: source.label,
    };
    byClientId.set(config.clientId, config);
    ordered.push(config);
  }

  const defaultApp = ordered.find((app) => app.label === 'teer-dev') ?? ordered[0] ?? null;

  return {
    getByClientId(clientId) {
      return clientId ? (byClientId.get(clientId) ?? null) : null;
    },
    getDefault() {
      return defaultApp;
    },
    all() {
      return [...ordered];
    },
  };
}
