import type { ShopifyAppConfig } from '@/lib/shopify/app-registry';

export type EmbeddedInstallSelection =
  | { kind: 'default'; app: ShopifyAppConfig | null }
  | { kind: 'unknown_label'; app: null }
  | { kind: 'missing_credentials'; app: null }
  | { kind: 'selected'; app: ShopifyAppConfig };

type EmbeddedAppLookup = {
  getDefault: () => ShopifyAppConfig | null;
  getByLabel: (label: string) => ShopifyAppConfig | null;
  hasLabel: (label: string) => boolean;
};

export function selectEmbeddedInstallApp(
  appLabel: string | null,
  lookup: EmbeddedAppLookup,
): EmbeddedInstallSelection {
  if (!appLabel) {
    return { kind: 'default', app: lookup.getDefault() };
  }

  if (!lookup.hasLabel(appLabel)) {
    return { kind: 'unknown_label', app: null };
  }

  const app = lookup.getByLabel(appLabel);
  return app ? { kind: 'selected', app } : { kind: 'missing_credentials', app: null };
}
