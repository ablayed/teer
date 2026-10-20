// Vérification de la signature d'un appel Upstash QStash, sur le CORPS BRUT et l'URL ATTENDUE.
//
// Module sans `env`, sans client Supabase : testable seul. La route qui l'appelle vérifie AVANT de
// construire le moindre client service-role.
import { Receiver } from '@upstash/qstash';

export type QstashVerification =
  | { ok: true }
  | { ok: false; reason: 'not_configured' | 'missing_signature' | 'invalid' };

export async function verifyQstashRequest(input: {
  signature: string | null;
  rawBody: string;
  // URL exacte déclarée dans la planification QStash. Jamais déduite de la requête reçue.
  expectedUrl: string | undefined;
  currentSigningKey: string | undefined;
  nextSigningKey: string | undefined;
}): Promise<QstashVerification> {
  const { signature, rawBody, expectedUrl, currentSigningKey, nextSigningKey } = input;
  if (!expectedUrl || !currentSigningKey || !nextSigningKey) {
    return { ok: false, reason: 'not_configured' };
  }
  if (!signature) {
    return { ok: false, reason: 'missing_signature' };
  }

  try {
    const receiver = new Receiver({ currentSigningKey, nextSigningKey });
    // `verify` contrôle la signature (clé courante, puis suivante), le condensat du corps et la
    // destination (`sub`). Il lève si l'un des trois ne correspond pas.
    const valid = await receiver.verify({ signature, body: rawBody, url: expectedUrl });
    return valid ? { ok: true } : { ok: false, reason: 'invalid' };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}
