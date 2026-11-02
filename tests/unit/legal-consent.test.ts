import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createProtectedSupabaseClient: vi.fn(),
  currentDocuments: [] as Array<Record<string, unknown>>,
  currentConsents: [] as Array<Record<string, unknown>>,
  queries: new Map<string, { in: ReturnType<typeof vi.fn> }>(),
}));

vi.mock('@/lib/env', () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321',
    SUPABASE_SERVICE_ROLE_KEY: 'unit-test-key',
  },
}));

vi.mock('@/lib/supabase/protected-client', () => ({
  createProtectedSupabaseClient: mocks.createProtectedSupabaseClient,
}));

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));
vi.mock('next/headers', () => ({ headers: vi.fn() }));

import { getMissingCurrentConsents, getSignupConsentDocuments } from '@/lib/legal/consent';

const REQUIRED_TYPES = ['cgu', 'privacy', 'mentions', 'dpa'];

function currentDocuments(version: string) {
  return REQUIRED_TYPES.map((type) => ({
    type,
    version,
    content_hash: `current-${type}`,
    body_url: `/${type}`,
  }));
}

function acceptedDocuments(types: string[], version: string) {
  return types.map((type) => ({
    document_type: type,
    document_version: version,
    content_hash: version === '2.0' ? `current-${type}` : `previous-${type}`,
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.queries.clear();
  mocks.currentDocuments = currentDocuments('2.0');
  mocks.currentConsents = acceptedDocuments(REQUIRED_TYPES, '1.2');

  mocks.createProtectedSupabaseClient.mockReturnValue({
    from: (table: string) => {
      const result = table === 'legal_documents' ? mocks.currentDocuments : mocks.currentConsents;
      const query = {
        select: vi.fn(),
        eq: vi.fn(),
        in: vi.fn().mockResolvedValue({ data: result, error: null }),
      };
      query.select.mockReturnValue(query);
      query.eq.mockReturnValue(query);
      mocks.queries.set(table, query);
      return query;
    },
  });
});

describe('getMissingCurrentConsents — réacceptation des quatre documents légaux', () => {
  it('fournit les quatre documents courants au consentement d’inscription', async () => {
    const result = await getSignupConsentDocuments();

    expect(result.ok && result.documents.map((document) => document.type)).toEqual(REQUIRED_TYPES);
  });

  it('renvoie les quatre documents v2 si le compte n’a que les anciennes versions', async () => {
    const result = await getMissingCurrentConsents('user-1');

    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.documents.map((document) => document.type)).toEqual(REQUIRED_TYPES);
    expect(mocks.queries.get('legal_documents')?.in).toHaveBeenCalledWith('type', REQUIRED_TYPES);
    expect(mocks.queries.get('user_consents')?.in).toHaveBeenCalledWith(
      'document_type',
      REQUIRED_TYPES,
    );
  });

  it('contrôle positif : un consentement courant reconnu n’est pas redemandé', async () => {
    mocks.currentConsents = acceptedDocuments(['cgu'], '2.0');

    const result = await getMissingCurrentConsents('user-1');

    expect(result.ok && result.documents.map((document) => document.type)).toEqual([
      'privacy',
      'mentions',
      'dpa',
    ]);
  });
});
