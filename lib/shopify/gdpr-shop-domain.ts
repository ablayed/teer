// SHOPIFY-OAUTH-FIRST-01 / D20a — domaine faisant autorité pour les webhooks RGPD
// (`customers/data_request`, `customers/redact`, `shop/redact`).
//
// Appelé APRÈS la vérification du HMAC sur le corps BRUT et le parsing du corps. Le `shop_domain`
// du corps signé fait autorité ; l'en-tête `x-shopify-shop-domain`, non signé, doit lui être
// STRICTEMENT égal. Ordre imposé, sur le corps ET sur l'en-tête :
//   1. `trim` des extrémités seulement, puis minuscules ;
//   2. rejet de toute valeur contenant un espace INTERNE — aucun espace n'est « retiré » : une
//      valeur invalide ne doit jamais devenir valide ;
//   3. forme canonique `^[a-z0-9][a-z0-9-]*\.myshopify\.com$` ;
//   4. égalité stricte des deux valeurs normalisées.
// Absence, invalidité ou divergence : rejet, AVANT toute lecture de données client, toute DSAR
// et toute suppression.
//
// Module pur : aucune dépendance.
const CANONICAL_SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

export type GdprShopDomainResult =
  | { ok: true; shopDomain: string }
  | { ok: false; reason: 'missing' | 'invalid' | 'mismatch' };

type Normalized = { kind: 'absent' } | { kind: 'invalid' } | { kind: 'valid'; value: string };

function normalize(raw: string | null): Normalized {
  if (raw === null) {
    return { kind: 'absent' };
  }
  const value = raw.trim().toLowerCase();
  if (value === '') {
    return { kind: 'absent' };
  }
  if (/\s/.test(value)) {
    return { kind: 'invalid' };
  }
  if (!CANONICAL_SHOP_DOMAIN.test(value)) {
    return { kind: 'invalid' };
  }
  return { kind: 'valid', value };
}

function bodyShopDomain(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  for (const key of ['shop_domain', 'myshopify_domain']) {
    const value = record[key];
    if (typeof value === 'string') {
      return value;
    }
  }
  return null;
}

export function resolveGdprShopDomain(
  headerShopDomain: string | null,
  payload: unknown,
): GdprShopDomainResult {
  const body = normalize(bodyShopDomain(payload));
  const header = normalize(headerShopDomain);

  if (body.kind === 'invalid' || header.kind === 'invalid') {
    return { ok: false, reason: 'invalid' };
  }
  if (body.kind === 'absent' || header.kind === 'absent') {
    return { ok: false, reason: 'missing' };
  }
  if (body.value !== header.value) {
    return { ok: false, reason: 'mismatch' };
  }
  return { ok: true, shopDomain: body.value };
}
