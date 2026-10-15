import { pickMessages } from '@/lib/i18n/pick-messages';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages } from 'next-intl/server';
import type { ReactNode } from 'react';

// Messages par sous-arbre client (V3). Le layout de l'application ne livre au navigateur que les
// espaces de noms de sa coque ; chaque page déclare ceux dont ses composants clients ont besoin.
// Les composants SERVEUR n'en dépendent pas : ils lisent `getTranslations` côté serveur.
//
// Un espace de noms oublié se voit à l'exécution (clé affichée à la place du texte) : la garde
// tests/unit/i18n/namespace-coverage.test.ts l'attrape avant, par le graphe d'imports de chaque page.
export async function MessagesFor({
  children,
  namespaces,
}: {
  children: ReactNode;
  namespaces: readonly string[];
}) {
  const messages = await getMessages();
  return (
    <NextIntlClientProvider messages={pickMessages(messages as never, namespaces)}>
      {children}
    </NextIntlClientProvider>
  );
}

/**
 * Enveloppe une page : `export default withMessages(['orders', 'periodPicker'], Page)`.
 * Le tableau est lu tel quel par la garde de couverture : il doit rester un littéral.
 */
export function withMessages<Props>(
  namespaces: readonly string[],
  Page: (props: Props) => ReactNode | Promise<ReactNode>,
) {
  // La page n'est PAS attendue ici : `{await Page(props)}` retenait tout l'arbre jusqu'à la fin de la
  // page, et le clic d'une vue de /commandes juste après une création laissait alors l'URL inchangée
  // (4 échecs sur 8 en build de production, 0 sur 24 sans l'attente). Le fournisseur reçoit la
  // promesse de la page comme enfant, React serveur la résout.
  return function PageWithMessages(props: Props) {
    return <MessagesFor namespaces={namespaces}>{Page(props) as ReactNode}</MessagesFor>;
  };
}
