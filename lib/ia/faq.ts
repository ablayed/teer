import { type TeamRole, teamRoles } from '@/lib/team/permissions';

export type FaqEntry = {
  id: string;
  question: string;
  answer: string;
  // Rôle minimum pour voir l'entrée (agent = visible par tous).
  minRole: TeamRole;
};

// FAQ statique (pas de pgvector). Role-aware : les entrées finance sont
// réservées à owner / manager selon minRole. Aucune donnée chiffrée réelle
// ici — uniquement des explications de fonctionnement.
export const FAQ_ENTRIES: FaqEntry[] = [
  {
    id: 'cod-cycle',
    question: 'Comment fonctionne le cycle de vie d’une commande COD ?',
    answer:
      'Une commande suit quatre dimensions indépendantes : l’appel (à appeler → confirmée), la livraison (non assignée → programmée → en livraison → livrée/échouée), l’encaissement (attendu → collecté → remis) et le cycle global (ouverte → terminée/annulée/retournée). On change l’état via les actions de la fiche commande ; l’assistant ne fait que consulter.',
    minRole: 'agent',
  },
  {
    id: 'appels',
    question: 'À quoi servent les statuts d’appel ?',
    answer:
      'Ils tracent la prise de contact : « à appeler » (jamais contacté), « à rappeler » (tentative sans réponse), « confirmée » (le client valide la commande), « injoignable ». La confirmation déclenche une réserve de stock non bloquante.',
    minRole: 'agent',
  },
  {
    id: 'stock-cump',
    question: 'Quand le stock est-il décompté et comment est calculé le coût ?',
    answer:
      'Le stock disponible n’est décrémenté qu’au moment du dispatch (assignation au livreur), pas à la confirmation (réserve souple). Le coût unitaire suit la méthode du coût moyen pondéré (CUMP), recalculé à chaque réception d’achat et figé sur chaque sortie.',
    minRole: 'agent',
  },
  {
    id: 'retour-rto',
    question: 'Quelle différence entre un RTO et un retour ?',
    answer:
      'Un RTO (return-to-origin) est un échec de livraison : la commande n’a jamais été livrée. Un retour intervient après une livraison réussie. Les deux sont suivis séparément dans les analyses.',
    minRole: 'manager',
  },
  {
    id: 'livreurs',
    question: 'Comment suivre le stock et le cash d’un livreur ?',
    answer:
      'L’onglet Livreurs montre, par livreur, le stock en main (dérivé du registre des mouvements), le cash dû/collecté/remis et la performance (taux de succès). L’assistant peut résumer la performance opérationnelle sur une période.',
    minRole: 'manager',
  },
  {
    id: 'finance-ca',
    question: 'Comment le chiffre d’affaires est-il calculé ?',
    answer:
      'Le CA encaissé ne compte que les commandes réellement encaissées sur la période (date d’encaissement), pas les commandes simplement marquées livrées. Les retours encaissés viennent en moins.',
    minRole: 'manager',
  },
  {
    id: 'finance-marge',
    question: 'Que recouvrent la marge brute et le résultat net ?',
    answer:
      'La marge brute = CA encaissé − coût des marchandises vendues (COGS au coût figé). Le résultat net retranche en plus les frais de mobile money et les charges (publicité, livreurs, loyer…). Ces chiffres sont réservés au propriétaire.',
    minRole: 'owner',
  },
];

const roleRank: Record<TeamRole, number> = { agent: 0, manager: 1, owner: 2 };

// Vérification de cohérence des données statiques (types stricts).
const KNOWN_ROLES = new Set<string>(teamRoles);

export function faqForRole(role: TeamRole): FaqEntry[] {
  return FAQ_ENTRIES.filter(
    (entry) => KNOWN_ROLES.has(entry.minRole) && roleRank[role] >= roleRank[entry.minRole],
  );
}
