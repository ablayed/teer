import messages from '@/messages/fr.json';
import { describe, expect, it } from 'vitest';

describe('textes Tableau CA', () => {
  it('distingue la définition CA collecté 7 j de CA encaissé période', () => {
    const ca7j = messages.tableau.kpi.ca_collecte_def;
    const caPeriod = messages.tableau.blocks.operationsEssentials.cashCollected.definition;

    expect(ca7j).not.toBe(caPeriod);
    expect(ca7j).toContain('7 derniers jours');
    expect(caPeriod).toContain('période sélectionnée');
    expect(ca7j).toContain('réellement encaissé');
    expect(caPeriod).toContain('réellement encaissé');
  });
});
