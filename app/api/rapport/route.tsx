import { registerPdfFonts } from '@/lib/pdf/fonts';
import { formatMoneyPdf } from '@/lib/pdf/format';
import { Document, Page, StyleSheet, Text, View, renderToStream } from '@react-pdf/renderer';
import type { ReactElement } from 'react';

export const runtime = 'nodejs';

const styles = StyleSheet.create({
  page: {
    backgroundColor: '#F4F3ED',
    color: '#111111',
    fontFamily: 'Geist',
    padding: 40,
  },
  card: {
    backgroundColor: '#FFFFFF',
    borderColor: '#E5E2D8',
    borderRadius: 8,
    borderWidth: 1,
    padding: 24,
  },
  date: {
    color: '#666666',
    fontSize: 12,
    marginTop: 16,
  },
  money: {
    fontFamily: 'Geist Mono',
    fontSize: 16,
    marginTop: 24,
  },
  title: {
    fontSize: 28,
    fontWeight: 700,
  },
});

function HelloReportDocument(): ReactElement {
  const generatedAt = new Intl.DateTimeFormat('fr-FR', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'Africa/Dakar',
  }).format(new Date());

  return (
    <Document author="Tëër" subject="Compte rendu de validation PDF" title="Compte rendu — Réglé">
      <Page size="A4" style={styles.page}>
        <View style={styles.card}>
          <Text style={styles.title}>Compte rendu — Réglé</Text>
          <Text style={styles.money}>Total : {formatMoneyPdf(1_234_567, 'XOF')}</Text>
          <Text style={styles.date}>Généré le {generatedAt}</Text>
        </View>
      </Page>
    </Document>
  );
}

export async function GET() {
  registerPdfFonts();

  const stream = await renderToStream(<HelloReportDocument />);

  return new Response(stream as unknown as BodyInit, {
    headers: {
      'Cache-Control': 'private, no-store',
      'Content-Disposition': 'attachment; filename="teer-hello-rapport.pdf"',
      'Content-Type': 'application/pdf',
    },
  });
}
