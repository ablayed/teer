import { env } from '@/lib/env';
import { Resend } from 'resend';

type SendSignupConfirmationEmailInput = {
  confirmationUrl: string;
  email: string;
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

export async function sendSignupConfirmationEmail({
  confirmationUrl,
  email,
}: SendSignupConfirmationEmailInput) {
  const safeUrl = escapeHtml(confirmationUrl);

  return resend.emails.send({
    from: env.RESEND_FROM_EMAIL,
    to: email,
    subject: 'Confirmez votre adresse e-mail sur Tëër',
    text: [
      'Bienvenue sur Tëër.',
      '',
      'Confirmez votre adresse e-mail pour activer votre compte :',
      confirmationUrl,
      '',
      "Si vous n'êtes pas à l'origine de cette inscription, vous pouvez ignorer ce message.",
    ].join('\n'),
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111111">
        <h1 style="font-size:24px;margin:0 0 16px">Confirmez votre adresse e-mail</h1>
        <p>Bienvenue sur Tëër.</p>
        <p>Confirmez votre adresse e-mail pour activer votre compte :</p>
        <p style="margin:24px 0">
          <a href="${safeUrl}" style="display:inline-block;background:#EE8243;color:#111111;text-decoration:none;font-weight:700;padding:12px 18px;border-radius:12px">
            Confirmer mon adresse e-mail
          </a>
        </p>
        <p style="word-break:break-all">${safeUrl}</p>
        <p>Si vous n'êtes pas à l'origine de cette inscription, vous pouvez ignorer ce message.</p>
      </div>
    `,
  });
}
