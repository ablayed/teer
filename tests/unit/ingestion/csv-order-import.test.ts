import { previewCsvOrderImport } from '@/lib/ingestion/csv-order-import';
import { describe, expect, it } from 'vitest';

const header = 'order_key,title,quantity,unit_amount,customer_name,phone,currency';

describe('previewCsvOrderImport', () => {
  it('accepte une commande multi-lignes comme une seule unité atomique', () => {
    const preview = previewCsvOrderImport(
      `${header}\nA-1,Produit A,2,1000,Awa,771234567,XOF\nA-1,Produit B,1,500,Awa,771234567,XOF`,
    );
    expect(preview).toHaveLength(1);
    expect(preview[0]).toMatchObject({ orderKey: 'A-1', status: 'ready' });
    expect(preview[0]?.order?.data.totalAmount).toBe(2500);
    expect(preview[0]?.order?.data.lines).toHaveLength(2);
  });

  it('refuse toute la commande lorsqu’une seule de ses lignes est invalide, sans bloquer les autres', () => {
    const preview = previewCsvOrderImport(
      `${header}\nA-1,Produit A,1,1000,Awa,771234567,XOF\nA-1,Produit B,0,500,Awa,771234567,XOF\nB-2,Produit C,1,700,Binta,781234567,XOF`,
    );
    expect(preview.find((item) => item.orderKey === 'A-1')).toMatchObject({
      status: 'invalid',
      order: null,
    });
    expect(preview.find((item) => item.orderKey === 'B-2')).toMatchObject({ status: 'ready' });
  });

  it('refuse les champs répétés incohérents au grain de la commande', () => {
    const preview = previewCsvOrderImport(
      `${header}\nA-1,Produit A,1,1000,Awa,771234567,XOF\nA-1,Produit B,1,500,Binta,771234567,XOF`,
    );
    expect(preview[0]).toMatchObject({ status: 'invalid' });
    expect(preview[0]?.errors).toContain('Champ répété incohérent : customer_name.');
  });

  it('refuse un téléphone sénégalais invalide, comme la saisie manuelle', () => {
    const preview = previewCsvOrderImport(`${header}\nA-1,Produit A,1,1000,Awa,12,XOF`);
    expect(preview[0]).toMatchObject({ status: 'invalid', order: null });
    expect(preview[0]?.errors).toContain('Ligne 2 : phone est invalide.');
  });

  it('plafonne la longueur de order_key', () => {
    const preview = previewCsvOrderImport(
      `${header}\n${'K'.repeat(101)},Produit A,1,1000,Awa,771234567,XOF`,
    );
    expect(preview[0]).toMatchObject({ status: 'invalid', order: null });
  });

  it('n’interprète jamais le CSV comme un contexte de boutique', () => {
    const preview = previewCsvOrderImport(
      `${header},shop_id\nA-1,Produit A,1,1000,Awa,771234567,XOF,00000000-0000-0000-0000-000000000000`,
    );
    expect(preview[0]?.status).toBe('ready');
    expect(preview[0]?.order).not.toHaveProperty('shopId');
  });
});
