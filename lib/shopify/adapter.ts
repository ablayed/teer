// Phase 2 / Lot L2 — adaptateur Shopify du contrat PlatformConnector (CLAUDE.md, "Lot L2").
//
// PUR : aucun import Supabase, aucune Server Action, aucun repository, jamais une écriture.
// Vérifié par tests/unit/ingestion/adapter-import-boundary.test.ts (frontière d'imports) en plus
// du typage nominal de ResolvedConnectionContext (lib/ingestion/canonical.ts). node:crypto est le
// seul import externe : il ne touche ni la base ni le réseau.
//
// Ce module NE reparse PAS les payloads REST bruts (customer/line_items/...) — cette logique
// existe déjà, pure, dans app/api/shopify/webhooks/route.ts (mapOrderWebhookToOrderNode etc.) et
// lib/shopify/orders-sync.ts (ShopifyOrderNode et alliés). La dupliquer aurait été de la
// duplication de logique métier, pas une frontière plus propre. `normalizeShopify*` prend donc en
// entrée les nœuds DÉJÀ mappés (déjà purs, déjà testés) et les enveloppe dans le contrat canonique
// discriminé — l'identifiant externe est extrait une seule fois, ici.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  BulkOperationFinished,
  CanonicalOrder,
  CanonicalProduct,
  CanonicalRefund,
  VerifiedWebhook,
} from '@/lib/ingestion/canonical';

export type ShopifyAppCandidate = {
  readonly clientId: string;
  readonly clientSecret: string;
};

function hmacMatches(rawBody: string, hmacHeader: string, secret: string): boolean {
  if (!secret) {
    return false;
  }
  const digest = createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
  const expected = Buffer.from(digest, 'utf8');
  const received = Buffer.from(hmacHeader, 'utf8');
  if (expected.length !== received.length) {
    return false;
  }
  return timingSafeEqual(expected, received);
}

// Renvoie TOUTES les apps dont le secret valide — jamais de court-circuit (pas de canal temporel
// sur le nombre d'apps essayées). Avec des secrets distincts (cas réel), au plus une app valide un
// corps donné ; plus d'une entrée signale une collision de secrets, traitée comme une échec par
// l'appelant (authenticateShopifyWebhook), jamais résolue arbitrairement.
export function identifyValidatingApps(
  rawBody: string,
  hmacHeader: string | null | undefined,
  apps: readonly ShopifyAppCandidate[],
): ShopifyAppCandidate[] {
  if (!hmacHeader) {
    return [];
  }
  const matches: ShopifyAppCandidate[] = [];
  for (const app of apps) {
    if (hmacMatches(rawBody, hmacHeader, app.clientSecret)) {
      matches.push(app);
    }
  }
  return matches;
}

// Authentifie l'événement et rend l'app qui a validé, jamais un booléen (contrat PlatformConnector).
// externalConnectionId (le domaine boutique) doit être fourni par l'appelant : ce module ne lit
// aucun en-tête, aucune donnée de requête HTTP — il reçoit des valeurs déjà extraites.
export function authenticateShopifyWebhook({
  rawBody,
  hmacHeader,
  externalConnectionId,
  apps,
  payload,
}: {
  rawBody: string;
  hmacHeader: string | null | undefined;
  externalConnectionId: string | null;
  apps: readonly ShopifyAppCandidate[];
  payload: unknown;
}): VerifiedWebhook | null {
  if (!externalConnectionId) {
    return null;
  }
  const matches = identifyValidatingApps(rawBody, hmacHeader, apps);
  if (matches.length !== 1) {
    return null;
  }
  return {
    platformAppId: matches[0].clientId,
    externalConnectionId,
    payload,
  };
}

// ── Normalisation ────────────────────────────────────────────────────────────────────────────

export function normalizeShopifyOrder(orderNode: { id: string }): CanonicalOrder {
  return { kind: 'order', externalOrderId: orderNode.id, raw: orderNode };
}

export function normalizeShopifyProduct(productNode: { id: string }): CanonicalProduct {
  return { kind: 'product', externalProductId: productNode.id, raw: productNode };
}

export function normalizeShopifyRefund(refund: { orderId: string | null }): CanonicalRefund | null {
  if (!refund.orderId) {
    return null;
  }
  return { kind: 'refund', externalOrderId: refund.orderId, raw: refund };
}

export function normalizeShopifyBulkOperationFinished(raw: unknown): BulkOperationFinished {
  return { kind: 'bulk_operation_finished', raw };
}
