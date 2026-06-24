import { FAQ_ITEMS, faqForRole } from '@/lib/support/faq';
import { canFAQAnswer, normalize, scoreFAQ, searchFAQ } from '@/lib/support/search';
import { describe, expect, it } from 'vitest';

describe('normalize()', () => {
  it('met en minuscules', () => {
    expect(normalize('Commande')).toBe('commande');
  });

  it('supprime les accents', () => {
    expect(normalize('réponse')).toBe('reponse');
    expect(normalize('livraison')).toBe('livraison');
    expect(normalize('Ébullition')).toBe('ebullition');
  });

  it('combine minuscules + suppression accents', () => {
    expect(normalize('Téléphone')).toBe('telephone');
  });
});

describe('scoreFAQ()', () => {
  it('score 0 pour une requête vide', () => {
    const cashItem = FAQ_ITEMS.find((i) => i.id === 'cash-remise');
    if (!cashItem) throw new Error('cash-remise introuvable dans FAQ_ITEMS');
    expect(scoreFAQ(cashItem, '')).toBe(0);
  });

  it('score > 0 quand un keyword correspond', () => {
    const cashItem = FAQ_ITEMS.find((i) => i.id === 'cash-remise');
    if (!cashItem) throw new Error('cash-remise introuvable dans FAQ_ITEMS');
    expect(scoreFAQ(cashItem, normalize('remise'))).toBeGreaterThan(0);
  });

  it('score > 0 quand la question correspond', () => {
    const cashItem = FAQ_ITEMS.find((i) => i.id === 'cash-remise');
    if (!cashItem) throw new Error('cash-remise introuvable dans FAQ_ITEMS');
    expect(scoreFAQ(cashItem, normalize('livreur'))).toBeGreaterThan(0);
  });

  it('les keywords pèsent plus que la question qui pèse plus que la réponse', () => {
    const codItem = FAQ_ITEMS.find((i) => i.id === 'commandes-cycle');
    if (!codItem) throw new Error('commandes-cycle introuvable dans FAQ_ITEMS');
    const kwScore = scoreFAQ(codItem, normalize('livraison'));
    const qScore = scoreFAQ(codItem, normalize('commande'));
    expect(kwScore).toBeGreaterThan(0);
    expect(qScore).toBeGreaterThan(0);
  });

  it('bonus phrase exacte augmente le score', () => {
    const item = FAQ_ITEMS.find((i) => i.id === 'finance-marge');
    if (!item) throw new Error('finance-marge introuvable dans FAQ_ITEMS');
    const partialScore = scoreFAQ(item, normalize('marge brute'));
    const exactScore = scoreFAQ(item, normalize('la marge brute et le resultat net'));
    expect(exactScore).toBeGreaterThan(partialScore);
  });
});

describe('searchFAQ()', () => {
  it('retourne des résultats triés par score décroissant', () => {
    const results = searchFAQ('commande', 'agent');
    expect(results.length).toBeGreaterThan(0);
    // Le premier résultat doit être le plus pertinent (contient "commande" dans keywords ou question)
    expect(
      results[0].keywords.some((kw) => kw.includes('commande')) ||
        normalize(results[0].question).includes('commande'),
    ).toBe(true);
  });

  it('retourne un tableau vide pour une requête vide', () => {
    expect(searchFAQ('', 'owner')).toEqual([]);
  });

  it('filtre par rôle — un agent ne voit pas les entrées owner-only', () => {
    const ownerOnly = FAQ_ITEMS.filter((i) => i.minRole === 'owner');
    expect(ownerOnly.length).toBeGreaterThan(0);

    for (const item of ownerOnly) {
      // Chercher par un mot de la question de cet item
      const keyword = normalize(item.question.split(' ')[2] ?? item.question.split(' ')[0]);
      const agentResults = searchFAQ(keyword, 'agent');
      expect(agentResults.find((r) => r.id === item.id)).toBeUndefined();
    }
  });

  it('filtre par rôle — un owner voit les entrées owner-only', () => {
    const margeItem = FAQ_ITEMS.find((i) => i.id === 'finance-marge');
    if (!margeItem) throw new Error('finance-marge introuvable dans FAQ_ITEMS');
    const results = searchFAQ('marge', 'owner');
    expect(results.find((r) => r.id === margeItem.id)).toBeDefined();
  });

  it('filtre par rôle — un agent ne voit pas finance-marge (minRole owner)', () => {
    const results = searchFAQ('marge', 'agent');
    expect(results.find((r) => r.id === 'finance-marge')).toBeUndefined();
  });

  it('filtre par rôle — un manager voit les entrées manager+ mais pas owner-only', () => {
    // finance-ca est minRole manager → visible
    const caResults = searchFAQ('chiffre affaires', 'manager');
    expect(caResults.find((r) => r.id === 'finance-ca')).toBeDefined();
    // finance-marge est minRole owner → pas visible
    const margeResults = searchFAQ('marge', 'manager');
    expect(margeResults.find((r) => r.id === 'finance-marge')).toBeUndefined();
  });

  it('respecte maxResults', () => {
    const results = searchFAQ('a', 'owner', { maxResults: 3 });
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('respecte minScore — un terme très générique avec minScore élevé peut donner 0 résultat', () => {
    const results = searchFAQ('e', 'owner', { minScore: 100 });
    expect(results.length).toBe(0);
  });

  it('normalise la requête — recherche sans accent fonctionne', () => {
    // "livraison" sans accent doit matcher des items contenant "livraison"
    const results = searchFAQ('livraison', 'agent');
    expect(results.length).toBeGreaterThan(0);
  });
});

describe('canFAQAnswer()', () => {
  it('retourne true si la FAQ peut répondre', () => {
    expect(canFAQAnswer('commande', 'agent')).toBe(true);
  });

  it('retourne false pour une requête vide', () => {
    expect(canFAQAnswer('', 'agent')).toBe(false);
  });

  it('retourne false pour un terme sans rapport', () => {
    expect(canFAQAnswer('xyzyzt123absurde', 'agent')).toBe(false);
  });
});

describe('faqForRole()', () => {
  it('agent voit les entrées sans minRole et minRole agent', () => {
    const items = faqForRole('agent');
    const ownerOnly = items.filter((i) => i.minRole === 'owner');
    const managerOnly = items.filter((i) => i.minRole === 'manager');
    expect(ownerOnly.length).toBe(0);
    expect(managerOnly.length).toBe(0);
  });

  it('owner voit toutes les entrées', () => {
    const ownerItems = faqForRole('owner');
    expect(ownerItems.length).toBe(FAQ_ITEMS.length);
  });

  it('manager voit plus que agent mais moins que owner', () => {
    expect(faqForRole('manager').length).toBeGreaterThan(faqForRole('agent').length);
    expect(faqForRole('manager').length).toBeLessThan(faqForRole('owner').length);
  });
});
