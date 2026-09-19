import {
  PASSWORD_RESET_INVALID_LINK_PATH,
  PASSWORD_RESET_NEW_PASSWORD_PATH,
  isRecoveryAccessToken,
} from '@/lib/security/password-recovery';
import { safeRedirectPath } from '@/lib/security/safe-redirect';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * Rappel unique des liens envoyés par courriel (confirmation d'inscription ET
 * récupération de mot de passe). C'est la seule URL de rappel autorisée côté
 * Supabase en production — d'où le partage.
 *
 * Trois corrections apportées par le lot PWD-RESET-01, toutes mesurées :
 *
 *  • **L'erreur de l'échange n'est plus ignorée.** Un lien expiré, rejoué ou ouvert
 *    sur un autre appareil menait jusqu'ici à `/tableau`, donc à `/connexion`, SANS
 *    le moindre message. Vaut aussi pour la confirmation d'inscription : c'est le
 *    même code, et le taire plus longtemps n'avait pas de justification.
 *
 *  • **Une session de récupération va à l'écran de nouveau mot de passe, et nulle
 *    part ailleurs.** La nature de la session est lue dans le jeton signé
 *    (`amr: recovery`), jamais dans l'URL : aucun paramètre de requête ne peut
 *    déplacer cette destination.
 *
 *  • **`redirectTo` passe désormais par `safeRedirectPath`.** Le garde local
 *    (`startsWith('/') && !startsWith('//')`) laissait passer `/\evil.example`, que
 *    `new URL()` normalise en `https://evil.example/` — une redirection ouverte.
 *    La barrière partagée rejette explicitement l'antislash ; elle n'était pas
 *    utilisée ici.
 */
export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get('code');
  const redirectTo = requestUrl.searchParams.get('redirectTo');

  // GoTrue rend `error` + `error_code` en query sur un lien expiré, rejoué ou
  // inconnu — les trois sont indistinguables (`otp_expired` dans les trois cas).
  const linkError =
    requestUrl.searchParams.get('error_code') ?? requestUrl.searchParams.get('error');
  if (linkError) {
    return NextResponse.redirect(new URL(PASSWORD_RESET_INVALID_LINK_PATH, requestUrl.origin));
  }

  if (code) {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);

    if (error) {
      return NextResponse.redirect(new URL(PASSWORD_RESET_INVALID_LINK_PATH, requestUrl.origin));
    }

    if (isRecoveryAccessToken(data.session?.access_token)) {
      return NextResponse.redirect(new URL(PASSWORD_RESET_NEW_PASSWORD_PATH, requestUrl.origin));
    }
  }

  return NextResponse.redirect(
    new URL(safeRedirectPath(redirectTo ?? undefined), requestUrl.origin),
  );
}
