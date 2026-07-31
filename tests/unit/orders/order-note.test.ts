import { ORDER_NOTE_MAX_LENGTH, normalizeOrderNote } from '@/lib/orders/order-note';
import { describe, expect, it } from 'vitest';

describe('normalizeOrderNote', () => {
  it('rend null pour toute saisie vide', () => {
    expect(normalizeOrderNote(null)).toBeNull();
    expect(normalizeOrderNote(undefined)).toBeNull();
    expect(normalizeOrderNote('')).toBeNull();
    expect(normalizeOrderNote('   ')).toBeNull();
    expect(normalizeOrderNote('\n\t ')).toBeNull();
  });

  it('rogne les espaces de bord sans toucher au contenu interne', () => {
    expect(normalizeOrderNote('  Rappeler apres 18h  ')).toBe('Rappeler apres 18h');
    expect(normalizeOrderNote('Ligne 1\nLigne 2')).toBe('Ligne 1\nLigne 2');
  });

  it('partage la meme limite que le compteur UI et la contrainte base', () => {
    expect(ORDER_NOTE_MAX_LENGTH).toBe(500);
  });
});
