import { buildWhatsappShareUrl, formatProduits, safeText } from '@/lib/whatsapp/format';
import { normalizeWhatsAppSenegalPhone } from '@/lib/whatsapp/link';
import { describe, expect, it } from 'vitest';

describe('normalizeWhatsAppSenegalPhone', () => {
  it.each([
    ['+221 77 123 45 67', '221771234567'],
    ['77 123 45 67', '221771234567'],
    ['077 123 45 67', '221771234567'],
    ['00221 79 123 45 67', '221791234567'],
  ])('normalise %s', (input, expected) => {
    expect(normalizeWhatsAppSenegalPhone(input)).toBe(expected);
  });

  it('retourne null pour un numéro invalide', () => {
    expect(normalizeWhatsAppSenegalPhone('+221 33 123 45 67')).toBeNull();
  });
});

describe('buildWhatsappShareUrl', () => {
  it('utilise api.whatsapp.com/send sans phone=', () => {
    const url = buildWhatsappShareUrl('Bonjour test');
    expect(url).toContain('https://api.whatsapp.com/send');
    expect(url).not.toContain('wa.me');
    expect(url).not.toContain('phone=');
  });

  it('encode le texte dans le paramètre text=', () => {
    const url = buildWhatsappShareUrl('Commande #1007\nTotal : 12 500 F CFA');
    const parsed = new URL(url);
    expect(parsed.searchParams.get('text')).toBe('Commande #1007\nTotal : 12 500 F CFA');
  });

  it('encode correctement les emojis et accents', () => {
    const url = buildWhatsappShareUrl('Bonjour 😊\nMerci');
    expect(url).toContain(encodeURIComponent('Bonjour 😊\nMerci'));
  });

  it('ne contient pas de paramètre phone même pour un message livreur avec téléphone dans le corps', () => {
    const url = buildWhatsappShareUrl('+221 77 123 45 67\nDakar Plateau');
    const parsed = new URL(url);
    expect(parsed.searchParams.has('phone')).toBe(false);
  });
});

describe('safeText', () => {
  it('retourne — pour null', () => expect(safeText(null)).toBe('—'));
  it('retourne — pour undefined', () => expect(safeText(undefined)).toBe('—'));
  it('retourne — pour chaîne vide', () => expect(safeText('')).toBe('—'));
  it('retourne — pour chaîne avec espaces uniquement', () => expect(safeText('   ')).toBe('—'));
  it('retourne la valeur trimée sinon', () => expect(safeText('  Dakar  ')).toBe('Dakar'));
});

describe('formatProduits', () => {
  it('retourne — pour liste vide', () => {
    expect(formatProduits([])).toBe('—');
  });

  it('retourne — pour null', () => {
    expect(formatProduits(null)).toBe('—');
  });

  it('formate les articles avec quantité×', () => {
    const result = formatProduits([
      { nom: 'Écouteurs', quantite: 2 },
      { nom: 'Câble USB', quantite: 1 },
    ]);
    expect(result).toContain('2x Écouteurs');
    expect(result).toContain('1x Câble USB');
  });
});
