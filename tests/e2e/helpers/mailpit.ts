import { supabaseUrl } from './auth';

/**
 * Boîte aux lettres de développement du stack Supabase local.
 *
 * Le conteneur s'appelle encore `supabase_inbucket_*` pour des raisons
 * historiques, mais l'image servie par le CLI 2.102.0 est **Mailpit** : l'API
 * est `/api/v1/messages`, pas celle d'Inbucket. Mesuré le 2026-09-19 —
 * `supabase status` affiche d'ailleurs « Mailpit ». Ne pas se fier au nom du
 * conteneur pour deviner l'API.
 */
export function mailpitOrigin(): string {
  const url = new URL(supabaseUrl || 'http://127.0.0.1:54321');
  url.port = '54324';
  return url.origin;
}

type MailpitMessage = {
  ID: string;
  To?: Array<{ Address?: string }>;
};

export async function clearMailbox(): Promise<void> {
  await fetch(`${mailpitOrigin()}/api/v1/messages`, { method: 'DELETE' });
}

/**
 * Corps texte du dernier message adressé à `email`, lignes quoted-printable
 * recollées. Sans ce recollage le lien ressort tronqué : le corps est encodé sur
 * des lignes de 76 caractères et l'URL de récupération est plus longue que cela.
 */
export async function waitForMessageTo(
  email: string,
  { attempts = 40, intervalMs = 250 }: { attempts?: number; intervalMs?: number } = {},
): Promise<string | null> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await fetch(`${mailpitOrigin()}/api/v1/messages`);
    const listing = (await response.json()) as { messages?: MailpitMessage[] };
    const match = listing.messages?.find((message) =>
      message.To?.some((recipient) => recipient.Address?.toLowerCase() === email.toLowerCase()),
    );

    if (match) {
      const detail = (await (
        await fetch(`${mailpitOrigin()}/api/v1/message/${match.ID}`)
      ).json()) as { Text?: string };
      return String(detail.Text ?? '').replace(/=\r?\n/g, '');
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return null;
}

/** Lien `/auth/v1/verify` porté par un courriel de récupération. */
export function recoveryLinkIn(body: string): string | null {
  const match = body.match(/https?:[^\s)]+\/auth\/v1\/verify\?[^\s)]+/);
  return match ? match[0] : null;
}
