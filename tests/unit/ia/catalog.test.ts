import { resolvePeriod } from '@/lib/ia/periods';
import { IA_TOOL_CATALOG, getToolsForRole } from '@/lib/ia/tools';
import type { TeamRole } from '@/lib/team/permissions';
import { describe, expect, it } from 'vitest';

describe("catalogue d'outils IA — couche A (filtrage par rôle)", () => {
  const FINANCE_OR_ANALYTICS = new Set([
    'get_rto_rate',
    'get_cancellation_rate',
    'get_driver_performance',
  ]);

  it('expose tous les outils non sensibles à un agent et aucun outil analytics', () => {
    const names = getToolsForRole('agent').map((t) => t.name);
    expect(names).toContain('get_order_status_summary');
    expect(names).toContain('get_low_stock');
    expect(names).toContain('get_top_products');
    expect(names).toContain('get_customer_reliability');
    for (const restricted of FINANCE_OR_ANALYTICS) {
      expect(names).not.toContain(restricted);
    }
  });

  it('expose les outils RTO/annulation/perf livreur à owner et manager', () => {
    for (const role of ['owner', 'manager'] as TeamRole[]) {
      const names = getToolsForRole(role).map((t) => t.name);
      for (const restricted of FINANCE_OR_ANALYTICS) {
        expect(names).toContain(restricted);
      }
    }
  });

  it('aucun outil v1 ne porte sur la marge / le coût / le profit', () => {
    for (const tool of IA_TOOL_CATALOG) {
      expect(tool.name).not.toMatch(/margin|marge|cogs|cout|profit|net/i);
    }
  });

  it('chaque outil déclare au moins un rôle autorisé et un nom unique', () => {
    const names = new Set<string>();
    for (const tool of IA_TOOL_CATALOG) {
      expect(tool.allowedRoles.length).toBeGreaterThan(0);
      expect(names.has(tool.name)).toBe(false);
      names.add(tool.name);
    }
  });
});

describe('résolution de période', () => {
  const now = new Date('2026-06-15T10:30:00.000Z');

  it('today démarre à minuit UTC', () => {
    const { from, to } = resolvePeriod('today', now);
    expect(from).toBe('2026-06-15T00:00:00.000Z');
    expect(to).toBe(now.toISOString());
  });

  it('7d remonte de 7 jours à minuit', () => {
    expect(resolvePeriod('7d', now).from).toBe('2026-06-08T00:00:00.000Z');
  });

  it('this_month démarre au 1er du mois', () => {
    expect(resolvePeriod('this_month', now).from).toBe('2026-06-01T00:00:00.000Z');
  });

  it('last_month couvre le mois précédent complet', () => {
    const { from, to } = resolvePeriod('last_month', now);
    expect(from).toBe('2026-05-01T00:00:00.000Z');
    expect(to).toBe('2026-06-01T00:00:00.000Z');
  });

  it("all démarre à l'epoch", () => {
    expect(resolvePeriod('all', now).from).toBe('1970-01-01T00:00:00.000Z');
  });
});
