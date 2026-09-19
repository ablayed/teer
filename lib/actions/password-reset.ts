'use server';

import { actionClient, authActionClient } from '@/lib/actions/safe-action';
import { env } from '@/lib/env';
import { checkPasswordStrength } from '@/lib/format/password';
import { checkAuthRateLimit, getClientIp } from '@/lib/security/auth-rate-limit';
import { isRecoveryAccessToken } from '@/lib/security/password-recovery';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import * as Sentry from '@sentry/nextjs';
import { headers } from 'next/headers';
import { z } from 'zod';

/**
 * Le schéma n'accepte QUE l'adresse. Aucun `next`, `redirectTo` ou `returnTo` :
 * la destination du lien est écrite dans le code (ci-dessous), jamais reçue.
 * Zod retire tout champ surnuméraire — un appelant qui en injecterait un ne
 * changerait rien.
 */
const requestPasswordResetSchema = z.object({
  email: z.string().email(),
});

const updatePasswordSchema = z
  .object({
    password: z.string().refine((value) => checkPasswordStrength(value).allValid, {
      message: 'weak_password',
    }),
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'password_mismatch',
    path: ['confirmPassword'],
  });

/**
 * Demande d'un lien de réinitialisation.
 *
 * **Réponse indifférenciée, et c'est l'invariant central de cette action.** Que
 * l'adresse existe ou non, que Supabase réponde ou tombe, l'appelant reçoit le
 * MÊME objet `{ ok: true }` — même statut HTTP, même corps, même écran. On ne
 * consulte jamais la base pour savoir si le compte existe : ce serait la première
 * fuite. Une panne du fournisseur part dans Sentry et nulle part ailleurs.
 *
 * Seule exception annoncée distinctement : la limitation de débit LOCALE par IP,
 * qui ne dépend d'aucun compte. L'intervalle de 26 s de Supabase, lui, est par
 * utilisateur — le remonter révélerait l'existence de l'adresse, donc il est
 * volontairement avalé dans la réponse neutre.
 */
export const requestPasswordResetAction = actionClient
  .metadata({ actionName: 'auth.request_password_reset', section: 'auth' })
  .inputSchema(requestPasswordResetSchema)
  .action(async ({ parsedInput }) => {
    const rate = await checkAuthRateLimit('password_reset', getClientIp(await headers()));
    if (!rate.ok) {
      return { ok: false as const, errorCode: 'rate_limited' as const };
    }

    const supabase = await createSupabaseServerClient();

    // Destination FIXE. `/auth/callback` est la seule URL de rappel autorisée côté
    // Supabase en production ; on la reproduit à l'octet près pour qu'aucun lien ne
    // parte avec une cible que GoTrue remplacerait silencieusement par la Site URL —
    // ce qui casserait le parcours APRÈS l'envoi du courriel.
    const { error } = await supabase.auth.resetPasswordForEmail(parsedInput.email, {
      redirectTo: new URL('/auth/callback', env.NEXT_PUBLIC_APP_URL).toString(),
    });

    if (error) {
      // Journalisé côté serveur UNIQUEMENT : le public ne doit pas distinguer une
      // panne d'envoi d'une adresse inconnue.
      Sentry.captureException(error, {
        tags: { action: 'auth.request_password_reset' },
        level: 'warning',
      });
    }

    return { ok: true as const };
  });

/**
 * Pose le nouveau mot de passe sur la session de récupération.
 *
 * N'utilise PAS `changePasswordAction` : celle-ci exige le mot de passe actuel, que
 * l'utilisateur ne connaît précisément pas.
 *
 * Gardée sur `amr = recovery` : sans cette garde, l'action deviendrait un chemin de
 * changement de mot de passe SANS ré-authentification pour n'importe quelle session
 * ouverte, c'est-à-dire un contournement de la garde de `changePasswordAction`.
 *
 * Les autres sessions du compte sont révoquées par Supabase lui-même — mesuré le
 * 2026-09-19 : après la mise à jour, les jetons des autres sessions rendent 403 et
 * leurs jetons de rafraîchissement 400, tandis que la session courante reste
 * valide. Rien à révoquer explicitement ici, et aucun arbitrage à trancher : « rester
 * connecté » et « couper les autres sessions » sont vrais tous les deux.
 */
export const updatePasswordFromRecoveryAction = authActionClient
  .metadata({ actionName: 'auth.update_password_from_recovery', section: 'auth' })
  .inputSchema(updatePasswordSchema)
  .action(async ({ ctx, parsedInput }) => {
    const {
      data: { session },
    } = await ctx.supabase.auth.getSession();

    if (!isRecoveryAccessToken(session?.access_token)) {
      return { ok: false as const, errorCode: 'invalid_session' as const };
    }

    const { error } = await ctx.supabase.auth.updateUser({ password: parsedInput.password });

    if (error) {
      Sentry.captureException(error, {
        tags: { action: 'auth.update_password_from_recovery' },
        level: 'warning',
      });
      return { ok: false as const, errorCode: 'update_failed' as const };
    }

    return { ok: true as const };
  });
