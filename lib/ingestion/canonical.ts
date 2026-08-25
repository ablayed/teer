// Phase 2 / Lot L2 — contrat PlatformConnector : types purs, partagés par tout adaptateur
// fournisseur (Shopify aujourd'hui, un futur fournisseur demain).
//
// AUCUN import Supabase/action serveur/repository ici, jamais. C'est la moitié "typage" de la
// preuve d'isolation de l'adaptateur (l'autre moitié est le test de frontière d'imports,
// tests/unit/ingestion/adapter-import-boundary.test.ts). Un module qui importe ce fichier reste
// éligible à l'allowlist de la frontière tant qu'il n'importe rien d'autre d'interdit.

// ── Authentification ────────────────────────────────────────────────────────────────────────
// Un adaptateur authentifie l'événement et rend l'app qui a validé — JAMAIS un booléen. C'est ce
// qui permet le recoupement d'app en aval (la couche applicative compare platformAppId au
// platform_app_id de la store_connection résolue, avant toute écriture).
export type VerifiedWebhook = {
  readonly platformAppId: string;
  readonly externalConnectionId: string;
  readonly payload: unknown;
};

// ── Enveloppe canonique ─────────────────────────────────────────────────────────────────────
// Discriminée par ressource, exprimée UNIQUEMENT en identifiants externes — jamais un identifiant
// interne (merchant_account_id/shop_id/orders.id/...), qui n'existe qu'après résolution de la
// connexion par la couche applicative. Pas de type unique fourre-tout : les sémantiques 0A-bis
// (commande / produit / remboursement / opération asynchrone) sont distinctes et le restent dans
// le typage.
export type CanonicalOrder = {
  readonly kind: 'order';
  readonly externalOrderId: string;
  readonly raw: unknown;
};

export type CanonicalProduct = {
  readonly kind: 'product';
  readonly externalProductId: string;
  readonly raw: unknown;
};

// Rattaché à une commande : un remboursement n'a pas d'identité propre dans ce lot (Shopify ne
// fournit qu'un id de transaction interne à la commande) — external_ref n'est jamais alimentée
// pour 'refund', entity_type absent de l'ensemble fermé de 0142. La double écriture pour ce
// topic se limite à ingestion_event.
export type CanonicalRefund = {
  readonly kind: 'refund';
  readonly externalOrderId: string;
  readonly raw: unknown;
};

// Opération asynchrone terminée, sans ressource propre — pas d'external_ref, ingestion_event
// seule.
export type BulkOperationFinished = {
  readonly kind: 'bulk_operation_finished';
  readonly raw: unknown;
};

export type CanonicalEnvelope =
  | CanonicalOrder
  | CanonicalProduct
  | CanonicalRefund
  | BulkOperationFinished;

// ── Contexte de connexion résolu ────────────────────────────────────────────────────────────
// Type nominal (brand non-exporté) : un identifiant brut (string) ne compile jamais là où un
// contexte résolu est attendu — c'est la moitié "typage" de la preuve #4 du lot (l'autre moitié
// est le test de frontière d'imports). Seul lib/ingestion/resolve-connection.ts (couche
// applicative, jamais un adaptateur) sait produire une valeur de ce type.
declare const RESOLVED_CONNECTION_BRAND: unique symbol;

export type ResolvedConnectionContext = {
  readonly [RESOLVED_CONNECTION_BRAND]: true;
  readonly storeConnectionId: string;
  readonly merchantAccountId: string;
  readonly shopId: string;
  readonly platform: string;
  readonly platformAppId: string | null;
};

export type ConnectionRefusalReason = 'unknown_connection' | 'app_mismatch';

export type ResolveConnectionResult =
  | { ok: true; context: ResolvedConnectionContext }
  | { ok: false; reason: ConnectionRefusalReason };
