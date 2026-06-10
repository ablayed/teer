import { isIP } from 'node:net';
import { env } from '@/lib/env';
import type { Database } from '@/lib/supabase/database.types';
import { createClient } from '@supabase/supabase-js';
import { headers } from 'next/headers';

type ConsentDocumentType = 'cgu' | 'privacy';

type ConsentDocument = {
  content_hash: string;
  type: ConsentDocumentType;
  version: string;
};

function createAdminClient() {
  return createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function normalizeIpAddress(candidate: string | null) {
  if (!candidate) {
    return null;
  }

  const normalized = candidate.split(',')[0]?.trim() ?? '';
  return isIP(normalized) ? normalized : null;
}

export async function getSignupConsentDocuments() {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('legal_documents')
    .select('type, version, content_hash')
    .eq('is_current', true)
    .in('type', ['cgu', 'privacy']);

  if (error) {
    return { ok: false as const };
  }

  const documents = new Map<ConsentDocumentType, ConsentDocument>();

  for (const document of data ?? []) {
    if (document.type !== 'cgu' && document.type !== 'privacy') {
      continue;
    }

    if (documents.has(document.type)) {
      return { ok: false as const };
    }

    documents.set(document.type, {
      type: document.type,
      version: document.version,
      content_hash: document.content_hash,
    });
  }

  const cgu = documents.get('cgu');
  const privacy = documents.get('privacy');

  if (!cgu || !privacy) {
    return { ok: false as const };
  }

  return { ok: true as const, documents: [cgu, privacy] };
}

export async function persistSignupConsents(userId: string, documents: ConsentDocument[]) {
  const admin = createAdminClient();
  const requestHeaders = await headers();
  const ipAddress =
    normalizeIpAddress(requestHeaders.get('x-forwarded-for')) ??
    normalizeIpAddress(requestHeaders.get('x-real-ip'));
  const userAgent = requestHeaders.get('user-agent')?.trim().slice(0, 1000) ?? null;

  const { error } = await admin.from('user_consents').insert(
    documents.map((document) => ({
      user_id: userId,
      document_type: document.type,
      document_version: document.version,
      content_hash: document.content_hash,
      ip_address: ipAddress,
      user_agent: userAgent,
      method: 'signup_checkbox',
    })),
  );

  if (error) {
    return { ok: false as const };
  }

  return { ok: true as const };
}

export async function deleteUserForFailedSignup(userId: string) {
  const admin = createAdminClient();
  const { error } = await admin.auth.admin.deleteUser(userId);

  return { ok: !error };
}
