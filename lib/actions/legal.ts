'use server';

import { authActionClient } from '@/lib/actions/safe-action';
import { getMissingCurrentConsents, persistSignupConsents } from '@/lib/legal/consent';
import { redirect } from 'next/navigation';
import { z } from 'zod';

const acceptCurrentLegalDocumentsSchema = z.object({
  acceptedLegal: z.literal(true),
  redirectTo: z.string().trim().max(500).optional(),
});

function safeRedirectPath(path: string | undefined) {
  if (!path || !path.startsWith('/') || path.startsWith('//') || path === '/reacceptation') {
    return '/tableau';
  }

  return path;
}

export const acceptCurrentLegalDocumentsAction = authActionClient
  .metadata({ actionName: 'legal.accept_current_documents', section: 'legal' })
  .inputSchema(acceptCurrentLegalDocumentsSchema)
  .action(async ({ ctx, parsedInput }) => {
    const missing = await getMissingCurrentConsents(ctx.user.id);

    if (!missing.ok) {
      return { ok: false as const, errorCode: 'legal_documents_unavailable' as const };
    }

    if (missing.documents.length > 0) {
      const consentResult = await persistSignupConsents(ctx.user.id, missing.documents);
      if (!consentResult.ok) {
        return { ok: false as const, errorCode: 'consent_record_failed' as const };
      }
    }

    redirect(safeRedirectPath(parsedInput.redirectTo));
  });
