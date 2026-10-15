import { withMessages } from '@/lib/i18n/messages-for';
import { describe, expect, it } from 'vitest';

// `withMessages` ne doit jamais attendre la page avant de rendre le fournisseur de messages :
// attendre retenait l'arbre entier et laissait l'URL d'une vue de /commandes inchangée après un clic
// intervenant juste après une création (régression mesurée en build de production).
describe('withMessages', () => {
  it('rend son enveloppe de façon synchrone, sans attendre la page', () => {
    let pageStarted = false;
    const Page = async () => {
      pageStarted = true;
      await new Promise(() => undefined);
      return null;
    };
    const wrapped = withMessages(['orders'], Page);
    const out = wrapped({});

    expect(out instanceof Promise).toBe(false);
    expect(pageStarted).toBe(true);
  });

  it('passe les propriétés de la page telles quelles', () => {
    const seen: unknown[] = [];
    const Page = (props: { a: number }) => {
      seen.push(props);
      return null;
    };
    withMessages(['orders'], Page)({ a: 1 });
    expect(seen).toEqual([{ a: 1 }]);
  });
});
