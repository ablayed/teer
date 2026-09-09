import { shouldShowSettlementScopeNote } from '@/lib/drivers/settlement-scope';
import messages from '@/messages/fr.json';
import { describe, expect, it } from 'vitest';

// Portée des versements sur /livreurs : la liste reste locataire (tous livreurs,
// toutes boutiques) alors que le parc de livreurs de la même page est filtré par
// boutique depuis 0133. C'est une décision (0064:12-14, 0133:30-32), pas un
// défaut — ces tests verrouillent le fait qu'elle soit DITE, et dite au bon
// moment, jamais qu'elle soit corrigée.
describe('shouldShowSettlementScopeNote', () => {
  it("n'affiche pas l'indice à un marchand mono-boutique (aucune divergence de portée)", () => {
    expect(shouldShowSettlementScopeNote(1)).toBe(false);
  });

  it("n'affiche pas l'indice quand le compte n'a aucune boutique accessible", () => {
    expect(shouldShowSettlementScopeNote(0)).toBe(false);
  });

  it("affiche l'indice dès la deuxième boutique — le parc est filtré, pas la liste", () => {
    expect(shouldShowSettlementScopeNote(2)).toBe(true);
    expect(shouldShowSettlementScopeNote(7)).toBe(true);
  });
});

describe('microcopie livreurs.settlements', () => {
  const settlements = messages.livreurs.settlements;

  it('nomme explicitement la portée dans le sous-titre', () => {
    // « tous livreurs confondus » (formulation d'avant 0133) décrivait la seule
    // portée alors possible ; elle ne dit plus rien une fois le parc filtré.
    expect(settlements.subtitle).not.toContain('tous livreurs confondus');
    expect(settlements.subtitle).toContain('tous les livreurs du compte');
  });

  it("dit « toutes boutiques » dans l'indice, et nulle part ailleurs", () => {
    expect(settlements.scopeNoteAllShops).toContain('toutes boutiques');
    expect(settlements.title).not.toContain('boutique');
    expect(settlements.subtitle).not.toContain('boutique');
  });

  it("rappelle dans l'indice que le parc affiché au-dessus, lui, est filtré", () => {
    expect(settlements.scopeNoteAllShops).toContain('boutique active');
  });

  it('respecte le vouvoiement (lexique de microcopie) — aucun tutoiement', () => {
    const strings = Object.values(settlements);
    for (const value of strings) {
      expect(value).not.toMatch(/\b(tu|ton|ta|tes|toi)\b/i);
    }
  });
});
