import { z } from 'zod';

// Enums STRICTS exposés au LLM (jamais de dates libres / SQL libre).
export const periodSchema = z
  .enum(['today', '7d', '30d', '90d', 'this_month', 'last_month', 'all'])
  .describe('Fenêtre temporelle : today, 7d, 30d, 90d, this_month, last_month, all.');

export type Period = z.infer<typeof periodSchema>;

// Canaux = valeurs autorisées de orders.source (cf. contrainte 0025).
export const channelSchema = z
  .enum(['shopify', 'whatsapp', 'manual', 'instagram', 'tiktok', 'facebook', 'appel'])
  .describe('Canal de vente (orders.source).');

export type Channel = z.infer<typeof channelSchema>;

export type ResolvedPeriod = { from: string; to: string };

// Résout une période en fenêtre UTC [from, to). Les timestamps sont stockés en
// UTC ; on calcule des bornes UTC (suffisant pour l'analytique v1).
export function resolvePeriod(period: Period, now: Date = new Date()): ResolvedPeriod {
  const to = now.toISOString();

  const startOfDay = (d: Date): Date => {
    const copy = new Date(d);
    copy.setUTCHours(0, 0, 0, 0);
    return copy;
  };

  const daysAgo = (n: number): string => {
    const d = startOfDay(now);
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString();
  };

  switch (period) {
    case 'today':
      return { from: startOfDay(now).toISOString(), to };
    case '7d':
      return { from: daysAgo(7), to };
    case '30d':
      return { from: daysAgo(30), to };
    case '90d':
      return { from: daysAgo(90), to };
    case 'this_month': {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      return { from: d.toISOString(), to };
    }
    case 'last_month': {
      const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
      const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      return { from: from.toISOString(), to: monthEnd.toISOString() };
    }
    case 'all':
      return { from: new Date(0).toISOString(), to };
  }
}
