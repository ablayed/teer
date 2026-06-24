import { env } from '@/lib/env';
import { Resend } from 'resend';

type SendFeedbackEmailInput = {
  category: string;
  merchantAccountId: string;
  message: string;
  pageContext: string | null;
  userEmail: string | null;
};

const resend = new Resend(env.RESEND_API_KEY);

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Best-effort — l'appelant enveloppe dans try/catch.
// S'active automatiquement quand RESEND_FROM_EMAIL pointe sur un domaine vérifié.
export async function sendFeedbackEmail({
  category,
  merchantAccountId,
  message,
  pageContext,
  userEmail,
}: SendFeedbackEmailInput) {
  const escapedMessage = escapeHtml(message);
  const escapedCategory = escapeHtml(category);
  const escapedPage = pageContext ? escapeHtml(pageContext) : 'non renseignée';
  const escapedUser = userEmail ? escapeHtml(userEmail) : 'anonyme';

  return resend.emails.send({
    from: env.RESEND_FROM_EMAIL,
    to: env.RESEND_FROM_EMAIL,
    subject: `[Tëër Feedback] ${category} — ${merchantAccountId.slice(0, 8)}`,
    text: [
      `Catégorie : ${category}`,
      `Utilisateur : ${userEmail ?? 'anonyme'}`,
      `Compte : ${merchantAccountId}`,
      `Page : ${pageContext ?? 'non renseignée'}`,
      '',
      message,
    ].join('\n'),
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111111">
        <h2 style="font-size:18px;margin:0 0 12px">Nouveau feedback Tëër</h2>
        <table style="border-collapse:collapse;width:100%;margin-bottom:16px">
          <tr><td style="padding:4px 8px;font-weight:700;width:140px">Catégorie</td><td style="padding:4px 8px">${escapedCategory}</td></tr>
          <tr><td style="padding:4px 8px;font-weight:700">Utilisateur</td><td style="padding:4px 8px">${escapedUser}</td></tr>
          <tr><td style="padding:4px 8px;font-weight:700">Compte</td><td style="padding:4px 8px">${escapeHtml(merchantAccountId)}</td></tr>
          <tr><td style="padding:4px 8px;font-weight:700">Page</td><td style="padding:4px 8px">${escapedPage}</td></tr>
        </table>
        <div style="background:#f4f3ed;border-radius:8px;padding:12px;white-space:pre-wrap">${escapedMessage}</div>
      </div>
    `,
  });
}
