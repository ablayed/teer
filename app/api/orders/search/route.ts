import { getOrdersPageData } from '@/lib/actions/orders';
import { orderSavedViewIds } from '@/lib/domain/order-saved-views';
import { isAbortError } from '@/lib/monitoring/client-error-classification';
import { PcdAccessAuditError, sanitizePcdIdempotencyKey } from '@/lib/security/pcd-access-audit';
import { PcdAccessControlError } from '@/lib/security/pcd-access-controls';
import { NextResponse } from 'next/server';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const searchParamsSchema = z.object({
  dateFrom: z.string().datetime(),
  dateTo: z.string().datetime(),
  q: z.string(),
  shopId: z.string().uuid().nullable(),
  view: z.enum(orderSavedViewIds),
});

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
} as const;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = searchParamsSchema.safeParse({
    dateFrom: url.searchParams.get('dateFrom'),
    dateTo: url.searchParams.get('dateTo'),
    q: url.searchParams.get('q') ?? '',
    shopId: url.searchParams.get('shopId'),
    view: url.searchParams.get('view') ?? 'toutes',
  });

  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid search parameters' }, { status: 400 });
  }

  return runSearch(request, parsed);
}

async function runSearch(
  request: Request,
  parsed: ReturnType<typeof searchParamsSchema.safeParse>,
) {
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid search parameters' }, { status: 400 });
  }

  try {
    // Source de vérité unique : cette fonction porte notamment le bornage glissant à 12 mois
    // du chemin de recherche legacy. L'endpoint ne réimplémente aucun filtrage métier.
    const data = await getOrdersPageData(
      {
        dateFrom: parsed.data.dateFrom,
        dateTo: parsed.data.dateTo,
        search: parsed.data.q,
        shopId: parsed.data.shopId,
        view: parsed.data.view,
        auditIdempotencyKey: sanitizePcdIdempotencyKey(
          request.headers.get('x-teer-audit-request-id'),
        ),
      },
      request.signal,
    );

    return NextResponse.json(data, { headers: NO_STORE_HEADERS });
  } catch (error) {
    if (request.signal.aborted || isAbortError(error)) {
      return new Response(null, { headers: NO_STORE_HEADERS, status: 499 });
    }

    if (error instanceof PcdAccessAuditError) {
      return NextResponse.json(
        { error: 'audit_unavailable' },
        { headers: NO_STORE_HEADERS, status: 503 },
      );
    }

    if (error instanceof PcdAccessControlError) {
      return NextResponse.json(
        { error: error.code === 'quota_exceeded' ? 'rate_limited' : 'quota_unavailable' },
        { headers: NO_STORE_HEADERS, status: error.code === 'quota_exceeded' ? 429 : 503 },
      );
    }

    throw error;
  }
}

export async function POST(request: Request) {
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid search parameters' }, { status: 400 });
  }

  const parsed = searchParamsSchema.safeParse(input);
  return runSearch(request, parsed);
}
