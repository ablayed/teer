import { resolvePeriod } from '@/lib/ia/periods';
import { IA_TOOL_CATALOG, getToolsForRole } from '@/lib/ia/tools';
import type { TeamRole } from '@/lib/team/permissions';
import { describe, expect, it } from 'vitest';

describe("catalogue d'outils IA — couche A (filtrage par rôle)", () => {
  // Analytics pertes (owner+manager) et coût/CA (owner+manager).
  const OWNER_MANAGER_ONLY = new Set([
    'get_rto_rate',
    'get_cancellation_rate',
    'get_driver_performance',
    'get_revenue',
    'get_cogs',
  ]);
  // Marge et profit : owner uniquement.
  const OWNER_ONLY = new Set(['get_margin', 'get_net_profit']);

  it("expose à l'agent les outils opérationnels et AUCUN outil sensible", () => {
    const names = getToolsForRole('agent').map((t) => t.name);
    expect(names).toContain('get_order_status_summary');
    expect(names).toContain('get_low_stock');
    expect(names).toContain('get_top_products');
    expect(names).toContain('get_customer_reliability');
    for (const restricted of [...OWNER_MANAGER_ONLY, ...OWNER_ONLY]) {
      expect(names).not.toContain(restricted);
    }
  });

  it('expose RTO/annulation/perf livreur + CA/COGS à owner et manager', () => {
    for (const role of ['owner', 'manager'] as TeamRole[]) {
      const names = getToolsForRole(role).map((t) => t.name);
      for (const tool of OWNER_MANAGER_ONLY) {
        expect(names).toContain(tool);
      }
    }
  });

  it('réserve la marge et le résultat net au seul owner', () => {
    const ownerNames = getToolsForRole('owner').map((t) => t.name);
    const managerNames = getToolsForRole('manager').map((t) => t.name);
    for (const tool of OWNER_ONLY) {
      expect(ownerNames).toContain(tool);
      expect(managerNames).not.toContain(tool);
    }
  });

  it('les outils marge/profit déclarent allowedRoles = [owner]', () => {
    for (const tool of IA_TOOL_CATALOG) {
      if (OWNER_ONLY.has(tool.name)) {
        expect([...tool.allowedRoles]).toEqual(['owner']);
      }
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
