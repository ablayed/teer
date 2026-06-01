import { env } from '@/lib/env';
import { Resend } from 'resend';

type SendTeamInvitationEmailInput = {
  accountName: string;
  email: string;
  invitedByEmail: string;
  role: 'manager' | 'agent';
  token: string;
};

const resend = new Resend(env.RESEND_API_KEY);

function invitationUrl(token: string): string {
  const url = new URL('/invitation/accept', env.NEXT_PUBLIC_APP_URL);
  url.searchParams.set('token', token);
  return url.toString();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatRole(role: SendTeamInvitationEmailInput['role']): string {
  return role === 'manager' ? 'gestionnaire' : 'agent';
}

export async function sendTeamInvitationEmail({
  accountName,
  email,
  invitedByEmail,
  role,
  token,
}: SendTeamInvitationEmailInput) {
  const url = invitationUrl(token);
  const escapedAccount = escapeHtml(accountName);
  const escapedInviter = escapeHtml(invitedByEmail);
  const roleLabel = formatRole(role);
  const escapedRole = escapeHtml(roleLabel);

  return resend.emails.send({
    from: env.RESEND_FROM_EMAIL,
    to: email,
    subject: `Vous êtes invité·e à rejoindre ${accountName} sur Tëër`,
    text: [
      `${invitedByEmail} vous invite à rejoindre ${accountName} sur Tëër avec le rôle ${roleLabel}.`,
      '',
      `Accepter l'invitation : ${url}`,
      '',
      'Ce lien expire dans 7 jours.',
    ].join('\n'),
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111111">
        <h1 style="font-size:24px;margin:0 0 16px">Invitation Tëër</h1>
        <p>${escapedInviter} vous invite à rejoindre ${escapedAccount} sur Tëër avec le rôle ${escapedRole}.</p>
        <p style="margin:24px 0">
          <a href="${url}" style="display:inline-block;background:#EE8243;color:#111111;text-decoration:none;font-weight:700;padding:12px 18px;border-radius:12px">
            Accepter l'invitation
          </a>
        </p>
        <p>Ce lien expire dans 7 jours.</p>
      </div>
    `,
  });
}
