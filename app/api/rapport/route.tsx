import { registerPdfFonts } from '@/lib/pdf/fonts';
import { formatMoneyPdf } from '@/lib/pdf/format';
import { getReportData, reportFilename } from '@/lib/report/data';
import type { ReportData } from '@/lib/report/data';
import { ReportDocument } from '@/lib/report/document';
import { renderToStream } from '@react-pdf/renderer';
import { getTranslations } from 'next-intl/server';

export const runtime = 'nodejs';

function parseDate(value: string | null, fallback: Date, endOfDay = false): Date {
  if (!value) {
    return fallback;
  }

  const date = new Date(`${value}T00:00:00`);

  if (Number.isNaN(date.getTime())) {
    return fallback;
  }

  if (endOfDay) {
    date.setHours(23, 59, 59, 999);
  }

  return date;
}

function defaultFrom(now: Date): Date {
  const from = new Date(now);
  from.setHours(0, 0, 0, 0);
  from.setDate(from.getDate() - 29);

  return from;
}

function formatDateFr(date: Date): string {
  return new Intl.DateTimeFormat('fr-FR', {
    day: 'numeric',
    month: 'long',
    timeZone: 'Africa/Dakar',
    year: 'numeric',
  }).format(date);
}

function formatDateTimeFr(date: Date): string {
  return new Intl.DateTimeFormat('fr-FR', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'Africa/Dakar',
  }).format(date);
}

export async function GET(request: Request) {
  registerPdfFonts();
  const t = await getTranslations('report');
  const finance = await getTranslations('finance');
  const url = new URL(request.url);
  const now = new Date();
  const to = parseDate(url.searchParams.get('to'), now, true);
  const from = parseDate(url.searchParams.get('from'), defaultFrom(now));
  let data: ReportData;

  try {
    data = await getReportData({
      from,
      shopId: url.searchParams.get('shopId'),
      to,
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'UNAUTHENTICATED') {
      return new Response(t('unauthenticated'), { status: 401 });
    }

    if (error instanceof Error && error.message === 'FORBIDDEN') {
      return new Response(t('forbidden'), { status: 403 });
    }

    return new Response(t('error'), { status: 500 });
  }
  const labels = {
    agingTitle: finance('charts.aging'),
    amount: t('amount'),
    cashDrivers: finance('kpis.cashDrivers'),
    collected: t('collected'),
    deliveredRevenue: finance('kpis.caUnified'),
    disclaimer: finance('disclaimer'),
    empty: finance('charts.empty'),
    estimatedMargin: finance('kpis.marginEstimate'),
    feesTitle: t('feesTitle'),
    generatedBy: t('generatedBy'),
    generatedOn: t('generatedOn'),
    grossMarginEstimated: finance('kpis.margin'),
    headerTitle: t('headerTitle'),
    pnl: {
      ca: finance('profit.ca'),
      cogs: finance('profit.netCogs'),
      expenses: finance('profit.expenses'),
      expensesTitle: finance('profit.pdfExpensesTitle'),
      deliveryFees: finance('profit.deliveryFees'),
      grossMargin: finance('profit.grossMargin'),
      marginEstimated: finance('profit.marginEstimated'),
      marginReal: finance('profit.marginReal'),
      mobileMoney: finance('profit.mobileMoney'),
      netCa: finance('profit.netCa'),
      netProfit: finance('profit.netProfit'),
      productMarginTitle: finance('profit.pdfProductMarginTitle'),
      returns: finance('profit.returns'),
      title: finance('profit.title'),
    },
    method: {
      ESPECES: finance('methods.ESPECES'),
      FREE_MONEY: finance('methods.FREE_MONEY'),
      ORANGE_MONEY: finance('methods.ORANGE_MONEY'),
      WAVE: finance('methods.WAVE'),
    },
    pending: t('pending'),
    period: t('period'),
    productsTitle: t('productsTitle'),
    quantity: t('quantity'),
    reconciliationTitle: t('reconciliationTitle'),
    refusalRate: finance('kpis.rto'),
    reportTitle: t('title'),
    settled: t('settled'),
    shortfall: t('shortfall'),
    status: {
      A_APPELER: finance('status.A_APPELER'),
      ANNULEE: finance('status.ANNULEE'),
      CONFIRMEE: finance('status.CONFIRMEE'),
      EN_LIVRAISON: finance('status.EN_LIVRAISON'),
      LIVREE: finance('status.LIVREE'),
      PROGRAMMEE: finance('status.PROGRAMMEE'),
      REFUSEE: finance('status.REFUSEE'),
      TENTEE: finance('status.TENTEE'),
    },
    statusTitle: t('statusTitle'),
    total: t('total'),
    trendTitle: t('trendTitle'),
  };

  const stream = await renderToStream(
    <ReportDocument
      data={data}
      formatDate={formatDateFr}
      formatDateTime={formatDateTimeFr}
      formatMoney={formatMoneyPdf}
      labels={labels}
    />,
  );
  const filename = reportFilename({ from: data.from, shopSlug: data.shop.slug, to: data.to });

  return new Response(stream as unknown as BodyInit, {
    headers: {
      'Cache-Control': 'private, no-store',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Type': 'application/pdf',
    },
  });
}
