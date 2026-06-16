import type { ReportData, ReportStatusSummary } from '@/lib/report/data';
import { Document, Page, Polyline, StyleSheet, Svg, Text, View } from '@react-pdf/renderer';

type ReportLabels = {
  agingTitle: string;
  amount: string;
  cashDrivers: string;
  collected: string;
  deliveredRevenue: string;
  disclaimer: string;
  empty: string;
  estimatedMargin: string;
  feesTitle: string;
  generatedBy: string;
  generatedOn: string;
  grossMarginEstimated: string;
  headerTitle: string;
  method: Record<string, string>;
  pending: string;
  period: string;
  // Compte de résultat (P&L) — clés finance.profit.* + marge par produit.
  pnl: Record<string, string>;
  productsTitle: string;
  quantity: string;
  reconciliationTitle: string;
  refusalRate: string;
  reportTitle: string;
  settled: string;
  shortfall: string;
  status: Record<string, string>;
  statusTitle: string;
  total: string;
  trendTitle: string;
};

type ReportDocumentProps = {
  data: ReportData;
  formatDate: (date: Date) => string;
  formatDateTime: (date: Date) => string;
  formatMoney: (amount: number, currency?: string | null) => string;
  labels: ReportLabels;
};

const colors = {
  accent: '#EE8243',
  border: '#E5E2D8',
  canvas: '#F4F3ED',
  danger: '#B42318',
  muted: '#666666',
  success: '#0E7C3A',
  surface: '#FFFFFF',
  text: '#111111',
};

const styles = StyleSheet.create({
  page: {
    backgroundColor: colors.canvas,
    color: colors.text,
    fontFamily: 'Geist',
    fontSize: 9,
    paddingBottom: 36,
    paddingHorizontal: 28,
    paddingTop: 34,
  },
  header: {
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 14,
    paddingBottom: 8,
  },
  footer: {
    borderTopColor: colors.border,
    borderTopWidth: 1,
    bottom: 18,
    color: colors.muted,
    flexDirection: 'row',
    fontSize: 8,
    justifyContent: 'space-between',
    left: 28,
    paddingTop: 6,
    position: 'absolute',
    right: 28,
  },
  hero: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 8,
    borderWidth: 1,
    marginBottom: 12,
    padding: 18,
  },
  h1: {
    fontSize: 26,
    fontWeight: 700,
    lineHeight: 1.12,
    marginTop: 5,
  },
  h2: {
    fontSize: 13,
    fontWeight: 700,
    marginBottom: 8,
  },
  eyebrow: {
    color: colors.muted,
    fontSize: 9,
    fontWeight: 600,
    textTransform: 'uppercase',
  },
  muted: {
    color: colors.muted,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 12,
  },
  kpi: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 8,
    borderWidth: 1,
    padding: 10,
    width: '31.8%',
  },
  kpiLabel: {
    color: colors.muted,
    fontSize: 8,
    marginBottom: 6,
  },
  kpiValue: {
    fontFamily: 'Geist Mono',
    fontSize: 13,
  },
  section: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 8,
    borderWidth: 1,
    marginBottom: 10,
    padding: 10,
  },
  row: {
    borderBottomColor: colors.border,
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: 8,
    minHeight: 22,
    paddingVertical: 5,
  },
  rowLast: {
    borderBottomWidth: 0,
  },
  cellGrow: {
    flexGrow: 1,
    flexShrink: 1,
  },
  cellSmall: {
    fontFamily: 'Geist Mono',
    textAlign: 'right',
    width: 68,
  },
  barTrack: {
    backgroundColor: colors.canvas,
    borderRadius: 4,
    height: 8,
    marginTop: 4,
    overflow: 'hidden',
  },
  bar: {
    backgroundColor: colors.accent,
    height: 8,
  },
  twoCols: {
    flexDirection: 'row',
    gap: 10,
  },
  col: {
    flex: 1,
  },
  dangerText: {
    color: colors.danger,
    fontFamily: 'Geist Mono',
  },
  successText: {
    color: colors.success,
    fontFamily: 'Geist Mono',
  },
});

function dateRange(data: ReportData, formatDate: (date: Date) => string) {
  return `${formatDate(data.from)} - ${formatDate(data.to)}`;
}

function Kpi({
  label,
  tone,
  value,
}: {
  label: string;
  tone?: 'danger' | 'success';
  value: string;
}) {
  const valueStyle =
    tone === 'danger'
      ? [styles.kpiValue, { color: colors.danger }]
      : tone === 'success'
        ? [styles.kpiValue, { color: colors.success }]
        : styles.kpiValue;

  return (
    <View style={styles.kpi}>
      <Text style={styles.kpiLabel}>{label}</Text>
      <Text style={valueStyle}>{value}</Text>
    </View>
  );
}

function rowStyle(isLast: boolean) {
  return isLast ? [styles.row, styles.rowLast] : styles.row;
}

function StatusRows({
  currency,
  formatMoney,
  labels,
  statuses,
}: {
  currency: string;
  formatMoney: (amount: number, currency?: string | null) => string;
  labels: ReportLabels;
  statuses: ReportStatusSummary[];
}) {
  const maxCount = Math.max(...statuses.map((item) => item.count), 1);

  return (
    <View>
      {statuses.map((item, index) => (
        <View key={item.status} style={rowStyle(index === statuses.length - 1)} wrap={false}>
          <View style={styles.cellGrow}>
            <Text>{labels.status[item.status] ?? item.status}</Text>
            <View style={styles.barTrack}>
              <View
                style={[styles.bar, { width: `${Math.max(4, (item.count / maxCount) * 100)}%` }]}
              />
            </View>
          </View>
          <Text style={styles.cellSmall}>{item.count}</Text>
          <Text style={styles.cellSmall}>{Math.round(item.percent * 100)} %</Text>
          <Text style={styles.cellSmall}>{formatMoney(item.amountMinor, currency)}</Text>
        </View>
      ))}
    </View>
  );
}

function RevenueChart({ data }: { data: ReportData }) {
  const width = 240;
  const height = 76;
  const maxValue = Math.max(...data.revenue.map((point) => point.valueMinor), 1);
  const step = data.revenue.length > 1 ? width / (data.revenue.length - 1) : width;
  const points = data.revenue
    .map((point, index) => {
      const x = index * step;
      const y = height - (point.valueMinor / maxValue) * height;
      return `${x},${y}`;
    })
    .join(' ');

  return (
    <Svg height={height} viewBox={`0 0 ${width} ${height}`} width={width}>
      <Polyline fill="none" points={points} stroke={colors.accent} strokeWidth={2} />
    </Svg>
  );
}

function Empty({ label }: { label: string }) {
  return <Text style={styles.muted}>{label}</Text>;
}

function PnlLine({
  bold,
  formatMoney,
  currency,
  label,
  last,
  value,
}: {
  bold?: boolean;
  currency: string;
  formatMoney: (amount: number, currency?: string | null) => string;
  label: string;
  last?: boolean;
  value: number;
}) {
  return (
    <View style={rowStyle(Boolean(last))} wrap={false}>
      <Text style={[styles.cellGrow, bold ? { fontWeight: 700 } : {}]}>{label}</Text>
      <Text style={[styles.cellSmall, bold ? { fontWeight: 700 } : {}]}>
        {formatMoney(value, currency)}
      </Text>
    </View>
  );
}

function PnlSection({
  currency,
  formatMoney,
  labels,
  profit,
}: {
  currency: string;
  formatMoney: (amount: number, currency?: string | null) => string;
  labels: ReportLabels;
  profit: NonNullable<ReportData['profit']>;
}) {
  const products = profit.productBreakdown;
  return (
    <>
      <View style={styles.section}>
        <Text style={styles.h2}>{labels.pnl.title}</Text>
        <PnlLine
          currency={currency}
          formatMoney={formatMoney}
          label={labels.pnl.ca}
          value={profit.caMinor}
        />
        {profit.deliveryFeesMinor > 0 ? (
          <PnlLine
            currency={currency}
            formatMoney={formatMoney}
            label={labels.pnl.deliveryFees}
            value={-profit.deliveryFeesMinor}
          />
        ) : null}
        {profit.returnContraRevenueMinor > 0 ? (
          <PnlLine
            currency={currency}
            formatMoney={formatMoney}
            label={labels.pnl.returns}
            value={-profit.returnContraRevenueMinor}
          />
        ) : null}
        <PnlLine
          bold
          currency={currency}
          formatMoney={formatMoney}
          label={labels.pnl.netCa}
          value={profit.netCAMinor}
        />
        <PnlLine
          currency={currency}
          formatMoney={formatMoney}
          label={labels.pnl.cogs}
          value={-profit.netCogsMinor}
        />
        <PnlLine
          bold
          currency={currency}
          formatMoney={formatMoney}
          label={labels.pnl.grossMargin}
          value={profit.grossMarginMinor}
        />
        {profit.mobileMoneyFeesMinor > 0 ? (
          <PnlLine
            currency={currency}
            formatMoney={formatMoney}
            label={labels.pnl.mobileMoney}
            value={-profit.mobileMoneyFeesMinor}
          />
        ) : null}
        {profit.expensesMinor > 0 ? (
          <PnlLine
            currency={currency}
            formatMoney={formatMoney}
            label={labels.pnl.expenses}
            value={-profit.expensesMinor}
          />
        ) : null}
        <PnlLine
          bold
          currency={currency}
          formatMoney={formatMoney}
          label={labels.pnl.netProfit}
          last
          value={profit.netProfitMinor}
        />
        <Text style={[styles.muted, { fontSize: 8, marginTop: 6 }]}>
          {profit.cogsEstimated ? labels.pnl.marginEstimated : labels.pnl.marginReal}
        </Text>
      </View>

      <View style={styles.twoCols}>
        <View style={[styles.section, styles.col]}>
          <Text style={styles.h2}>{labels.pnl.expensesTitle}</Text>
          {profit.expensesByCategory.length > 0 ? (
            profit.expensesByCategory.map((cat, index) => (
              <View
                key={cat.code}
                style={rowStyle(index === profit.expensesByCategory.length - 1)}
                wrap={false}
              >
                <Text style={styles.cellGrow}>{cat.label}</Text>
                <Text style={styles.cellSmall}>{formatMoney(cat.totalMinor, currency)}</Text>
              </View>
            ))
          ) : (
            <Empty label={labels.empty} />
          )}
        </View>

        <View style={[styles.section, styles.col]}>
          <Text style={styles.h2}>{labels.pnl.productMarginTitle}</Text>
          {products.length > 0 ? (
            products.slice(0, 10).map((product, index) => (
              <View
                key={product.productId}
                style={rowStyle(index === Math.min(products.length, 10) - 1)}
                wrap={false}
              >
                <Text style={styles.cellGrow}>
                  {product.title}
                  {product.estimated ? ' *' : ''}
                </Text>
                <Text style={styles.cellSmall}>{product.qtySold}</Text>
                <Text style={styles.cellSmall}>{formatMoney(product.cogsMinor, currency)}</Text>
              </View>
            ))
          ) : (
            <Empty label={labels.empty} />
          )}
        </View>
      </View>
    </>
  );
}

export function ReportDocument({
  data,
  formatDate,
  formatDateTime,
  formatMoney,
  labels,
}: ReportDocumentProps) {
  const currency = data.currency;

  return (
    <Document author="Tëër" subject={labels.reportTitle} title={labels.reportTitle}>
      <Page size="A4" style={styles.page}>
        <View fixed style={styles.header}>
          <Text>{data.shop.name}</Text>
          <Text style={styles.muted}>{labels.headerTitle}</Text>
        </View>

        <View fixed style={styles.footer}>
          <Text>{labels.generatedBy}</Text>
          <Text render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`} />
        </View>

        <View style={styles.hero}>
          <Text style={styles.eyebrow}>{data.shop.domain ?? 'Tëër'}</Text>
          <Text style={styles.h1}>{labels.reportTitle}</Text>
          <Text style={[styles.muted, { marginTop: 8 }]}>
            {labels.period} : {dateRange(data, formatDate)}
          </Text>
          <Text style={[styles.muted, { marginTop: 4 }]}>
            {labels.generatedOn} : {formatDateTime(data.generatedAt)}
          </Text>
          <Text style={[styles.muted, { fontSize: 8, marginTop: 6 }]}>{labels.disclaimer}</Text>
        </View>

        <View style={styles.grid}>
          <Kpi
            label={labels.deliveredRevenue}
            tone="success"
            value={formatMoney(data.kpis.ca_livre, currency)}
          />
          <Kpi label={labels.collected} value={formatMoney(data.kpis.encaisse, currency)} />
          <Kpi label={labels.pending} value={formatMoney(data.kpis.a_encaisser, currency)} />
          <Kpi
            label={labels.cashDrivers}
            value={formatMoney(data.kpis.cash_chez_livreurs, currency)}
          />
          <Kpi
            label={labels.grossMarginEstimated}
            value={formatMoney(data.kpis.margin_estimee, currency)}
          />
          <Kpi
            label={labels.refusalRate}
            tone={data.kpis.taux_refus > 20 ? 'danger' : undefined}
            value={`${Math.round(Number(data.kpis.taux_refus))} %`}
          />
        </View>

        <View style={styles.section}>
          <Text style={styles.h2}>{labels.statusTitle}</Text>
          <StatusRows
            currency={currency}
            formatMoney={formatMoney}
            labels={labels}
            statuses={data.statuses}
          />
        </View>

        <View style={styles.twoCols}>
          <View style={[styles.section, styles.col]}>
            <Text style={styles.h2}>{labels.trendTitle}</Text>
            {data.revenue.some((point) => point.valueMinor > 0) ? (
              <RevenueChart data={data} />
            ) : (
              <Empty label={labels.empty} />
            )}
          </View>

          <View style={[styles.section, styles.col]}>
            <Text style={styles.h2}>{labels.reconciliationTitle}</Text>
            {data.drivers.length > 0 ? (
              data.drivers.slice(0, 7).map((driver, index) => (
                <View
                  key={driver.driverId}
                  style={rowStyle(index === Math.min(data.drivers.length, 7) - 1)}
                  wrap={false}
                >
                  <Text style={styles.cellGrow}>{driver.driverName}</Text>
                  <Text style={styles.cellSmall}>{formatMoney(driver.settledMinor, currency)}</Text>
                  <Text style={styles.cellSmall}>{formatMoney(driver.pendingMinor, currency)}</Text>
                  <Text style={driver.shortfallMinor > 0 ? styles.dangerText : styles.cellSmall}>
                    {formatMoney(driver.shortfallMinor, currency)}
                  </Text>
                </View>
              ))
            ) : (
              <Empty label={labels.empty} />
            )}
          </View>
        </View>

        <View style={styles.twoCols}>
          <View style={[styles.section, styles.col]}>
            <Text style={styles.h2}>{labels.productsTitle}</Text>
            {data.topProducts.length > 0 ? (
              data.topProducts.map((product, index) => (
                <View
                  key={product.title}
                  style={rowStyle(index === data.topProducts.length - 1)}
                  wrap={false}
                >
                  <Text style={styles.cellGrow}>{product.title}</Text>
                  <Text style={styles.cellSmall}>{product.quantity}</Text>
                  <Text style={styles.cellSmall}>{formatMoney(product.amountMinor, currency)}</Text>
                </View>
              ))
            ) : (
              <Empty label={labels.empty} />
            )}
          </View>

          <View style={[styles.section, styles.col]}>
            <Text style={styles.h2}>{labels.feesTitle}</Text>
            {data.methods.length > 0 ? (
              data.methods.map((method, index) => (
                <View
                  key={method.method}
                  style={rowStyle(index === data.methods.length - 1)}
                  wrap={false}
                >
                  <Text style={styles.cellGrow}>
                    {labels.method[method.method] ?? method.method}
                  </Text>
                  <Text style={styles.cellSmall}>{formatMoney(method.settledMinor, currency)}</Text>
                  <Text style={styles.cellSmall}>{formatMoney(method.feeMinor, currency)}</Text>
                </View>
              ))
            ) : (
              <Empty label={labels.empty} />
            )}
          </View>
        </View>

        {data.profit ? (
          <PnlSection
            currency={currency}
            formatMoney={formatMoney}
            labels={labels}
            profit={data.profit}
          />
        ) : null}
      </Page>
    </Document>
  );
}
