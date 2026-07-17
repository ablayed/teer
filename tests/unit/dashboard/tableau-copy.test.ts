import messages from '@/messages/fr.json';
import { describe, expect, it } from 'vitest';

describe('textes Tableau CA', () => {
  it("ne réintroduit pas de carte KPI 'CA collecté (7 j)' redondante avec CA encaissé (période)", () => {
    expect('ca_collecte' in messages.tableau.kpi).toBe(false);
    expect('ca_collecte_def' in messages.tableau.kpi).toBe(false);
    expect('ca_collecte_formula' in messages.tableau.kpi).toBe(false);

    const caPeriod = messages.tableau.blocks.operationsEssentials.cashCollected.definition;
    expect(caPeriod).toContain('période sélectionnée');
    expect(caPeriod).not.toContain('CA collecté (7 j)');
  });
});
