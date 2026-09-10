import { normalizeSenegalPhone } from '@/lib/address/phone-sn';
import type { PersistableCanonicalOrder } from '@/lib/ingestion/canonical';
import { z } from 'zod';

export type CsvOrderImportPreview = {
  readonly orderKey: string;
  readonly rowNumbers: readonly number[];
  readonly status: 'ready' | 'invalid';
  readonly errors: readonly string[];
  readonly order: PersistableCanonicalOrder | null;
};

type CsvRow = { readonly values: Record<string, string>; readonly line: number };

const requiredColumns = [
  'order_key',
  'title',
  'quantity',
  'unit_amount',
  'customer_name',
  'phone',
] as const;
const repeatedColumns = [
  'order_number',
  'customer_name',
  'phone',
  'address1',
  'address2',
  'city',
  'province',
  'country',
  'zip',
  'currency',
  'total_amount',
] as const;

// Plafond de order_key : la clé part dans external_ref.external_id et dans la recherche
// `.in()` de la prévisualisation, sérialisée dans l'URL GET.
export const MAX_ORDER_KEY_LENGTH = 100;

function requiredText(column: string) {
  return z.string().refine((value) => value.trim().length > 0, `${column} est obligatoire`);
}

// Schéma explicite d'une ligne CSV (une ligne de commande). Le verdict est ensuite agrégé au
// grain order_key : une seule ligne en échec refuse toute la commande.
const csvOrderRowSchema = z.object({
  title: requiredText('title'),
  customer_name: requiredText('customer_name'),
  // Même règle que la saisie manuelle (findOrCreateCustomerByPhone) : un numéro sénégalais
  // non normalisable est refusé, jamais importé sans identité client dédoublonnable.
  phone: z.string().superRefine((value, ctx) => {
    if (!value.trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'phone est obligatoire' });
    } else if (!normalizeSenegalPhone(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'phone est invalide' });
    }
  }),
  quantity: z.string().refine((value) => {
    const quantity = toNumber(value);
    return quantity !== null && Number.isInteger(quantity) && quantity >= 1;
  }, 'quantity est invalide'),
  unit_amount: z.string().refine((value) => {
    const unitAmount = toNumber(value);
    return unitAmount !== null && unitAmount >= 0;
  }, 'unit_amount est invalide'),
});

function parseCells(text: string, delimiter: ',' | ';'): string[][] | null {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        value += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(value.trim());
      value = '';
    } else if (char === '\n') {
      row.push(value.trim().replace(/\r$/, ''));
      rows.push(row);
      row = [];
      value = '';
    } else {
      value += char;
    }
  }

  if (quoted) return null;
  row.push(value.trim().replace(/\r$/, ''));
  if (row.some((cell) => cell.length > 0)) rows.push(row);
  return rows;
}

function toNumber(value: string): number | null {
  const normalized = value.trim().replace(',', '.');
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function nullable(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed || null;
}

function sameRepeatedValue(rows: readonly CsvRow[], column: (typeof repeatedColumns)[number]) {
  const values = new Set(rows.map((row) => nullable(row.values[column])));
  return values.size <= 1;
}

/**
 * Parses an unpersisted CSV. A physical row is a command line; all rows with
 * one order_key are validated and accepted or rejected together.
 */
export function previewCsvOrderImport(csvText: string): CsvOrderImportPreview[] {
  const delimiter: ',' | ';' = csvText.split('\n', 1)[0]?.includes(';') ? ';' : ',';
  const cells = parseCells(csvText, delimiter);
  if (!cells || cells.length === 0) {
    return [
      {
        orderKey: '(fichier)',
        rowNumbers: [],
        status: 'invalid',
        errors: ['CSV invalide.'],
        order: null,
      },
    ];
  }

  const header = cells[0].map((value) => value.trim().toLowerCase());
  const missing = requiredColumns.filter((column) => !header.includes(column));
  if (missing.length > 0) {
    return [
      {
        orderKey: '(fichier)',
        rowNumbers: [1],
        status: 'invalid',
        errors: [`Colonnes obligatoires absentes : ${missing.join(', ')}.`],
        order: null,
      },
    ];
  }

  const rows: CsvRow[] = cells.slice(1).flatMap((values, index) => {
    if (values.every((value) => !value.trim())) return [];
    const valuesByColumn = Object.fromEntries(
      header.map((column, columnIndex) => [column, values[columnIndex] ?? '']),
    );
    return [{ values: valuesByColumn, line: index + 2 }];
  });
  const groups = new Map<string, CsvRow[]>();
  for (const row of rows) {
    const key = (row.values.order_key ?? '').trim();
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }

  return [...groups.entries()].map(([orderKey, orderRows]) => {
    const errors: string[] = [];
    if (!orderKey) errors.push('order_key est obligatoire.');
    if (orderKey.length > MAX_ORDER_KEY_LENGTH)
      errors.push(`order_key dépasse ${MAX_ORDER_KEY_LENGTH} caractères.`);
    for (const row of orderRows) {
      const parsed = csvOrderRowSchema.safeParse(row.values);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          errors.push(`Ligne ${row.line} : ${issue.message}.`);
        }
      }
    }
    for (const column of repeatedColumns) {
      if (!sameRepeatedValue(orderRows, column))
        errors.push(`Champ répété incohérent : ${column}.`);
    }
    const total = orderRows.reduce(
      (sum, row) =>
        sum +
        (toNumber(row.values.quantity ?? '') ?? 0) * (toNumber(row.values.unit_amount ?? '') ?? 0),
      0,
    );
    const declaredTotal = nullable(orderRows[0]?.values.total_amount);
    if (declaredTotal) {
      const parsed = toNumber(declaredTotal);
      if (parsed === null || parsed !== total)
        errors.push('total_amount ne correspond pas aux lignes de commande.');
    }
    if (errors.length > 0)
      return {
        orderKey,
        rowNumbers: orderRows.map((row) => row.line),
        status: 'invalid' as const,
        errors,
        order: null,
      };

    const first = orderRows[0];
    const address = {
      address1: nullable(first.values.address1),
      address2: nullable(first.values.address2),
      city: nullable(first.values.city),
      province: nullable(first.values.province),
      country: nullable(first.values.country),
      zip: nullable(first.values.zip),
    };
    const hasAddress = Object.values(address).some(Boolean);
    const now = new Date().toISOString();
    return {
      orderKey,
      rowNumbers: orderRows.map((row) => row.line),
      status: 'ready' as const,
      errors,
      order: {
        kind: 'order',
        externalOrderId: orderKey,
        raw: null,
        data: {
          payloadVersion: 'csv-v1',
          eventAt: now,
          createdAt: null,
          updatedAt: null,
          orderNumber: nullable(first.values.order_number),
          totalAmount: total,
          currency: nullable(first.values.currency),
          customer: {
            fullName: nullable(first.values.customer_name),
            phone: nullable(first.values.phone),
            address: hasAddress ? address : null,
          },
          shippingAddress: hasAddress ? address : null,
          lines: orderRows.map((row) => ({
            title: (row.values.title ?? '').trim(),
            sku: nullable(row.values.sku),
            quantity: toNumber(row.values.quantity ?? '') as number,
            unitAmount: toNumber(row.values.unit_amount ?? ''),
            productId: null,
          })),
        },
      },
    };
  });
}
