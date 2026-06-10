import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyWebhookHmac(
  rawBody: string,
  hmacHeader: string | null | undefined,
  secret: string,
): boolean {
  if (!hmacHeader) {
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

// Multi-app : vérifie l'HMAC contre une liste de secrets candidats (un par app). Renvoie true dès
// qu'un secret valide (comparaison timing-safe par secret). Utilisé quand l'app émettrice n'est pas
// connue de façon déterministe (boutique absente de la base : webhooks de conformité, désinstallée).
export function verifyWebhookHmacAnySecret(
  rawBody: string,
  hmacHeader: string | null | undefined,
  secrets: readonly string[],
): boolean {
  if (!hmacHeader) {
    return false;
  }

  let matched = false;
  // On itère sur TOUS les secrets (pas de court-circuit) pour ne pas exposer de canal temporel
  // sur le nombre de secrets essayés.
  for (const secret of secrets) {
    if (secret && verifyWebhookHmac(rawBody, hmacHeader, secret)) {
      matched = true;
    }
  }

  return matched;
}
