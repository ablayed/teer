import {
  buildWhatsAppConfirmationMessage,
  buildWhatsAppConfirmationUrl,
  buildWhatsAppDispatchUrlForDriver,
  normalizeWhatsAppSenegalPhone,
} from '@/lib/whatsapp/link';
import { describe, expect, it } from 'vitest';

const order = {
  address: 'Dakar Plateau',
  currency: 'XOF',
  customerFirstName: 'Moussa',
  itemsSummary: [{ price: 12500, quantity: 1, title: 'Écouteurs' }],
  orderNumber: '1007',
  phone: '+221 77 123 45 67',
  shopName: 'Boutique Tëër',
  totalAmount: 12500,
};

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

describe('buildWhatsAppConfirmationUrl', () => {
  it('encode les accents, les sauts de ligne et garde F CFA sans U+202F', () => {
    const url = buildWhatsAppConfirmationUrl(order);

    expect(url).not.toBeNull();
    expect(url).toContain('https://wa.me/221771234567?text=');
    expect(url).toContain('%C3%89couteurs');
    expect(url).toContain('%0A');
    expect(url).toContain('12%20500%20F%20CFA');
    expect(url).not.toContain('%E2%80%AF');
  });

  it('contient le numéro de commande, le total et la question de confirmation', () => {
    const message = buildWhatsAppConfirmationMessage(order);

    expect(message).toContain('commande n°1007');
    expect(message).toContain('12 500 F CFA');
    expect(message).toContain('Souhaitez-vous confirmer la livraison à Dakar Plateau ?');
  });
});

describe('buildWhatsAppDispatchUrlForDriver (C5)', () => {
  it('cible le numéro du LIVREUR (pas le client) avec le message d’expédition', () => {
    // phone = client (ligne « Tél » du message) ; le destinataire wa.me = le livreur.
    const url = buildWhatsAppDispatchUrlForDriver(order, '78 555 11 22');

    expect(url).not.toBeNull();
    expect(url).toContain('https://wa.me/221785551122?text=');
    // Le téléphone CLIENT apparaît dans le corps du message, pas comme destinataire.
    expect(url).toContain(encodeURIComponent('Tél : +221 77 123 45 67'));
    expect(url).toContain(encodeURIComponent('Total à encaisser'));
  });

  it('reflète le total édité passé en argument', () => {
    const url = buildWhatsAppDispatchUrlForDriver({ ...order, totalAmount: 30000 }, '781112233');
    expect(url).toContain(encodeURIComponent('30 000 F CFA'));
  });

  it('renvoie null si le livreur n’a pas de numéro mobile valide (fallback)', () => {
    expect(buildWhatsAppDispatchUrlForDriver(order, null)).toBeNull();
    expect(buildWhatsAppDispatchUrlForDriver(order, '')).toBeNull();
    expect(buildWhatsAppDispatchUrlForDriver(order, '33 123 45 67')).toBeNull(); // fixe, pas mobile
  });
});
