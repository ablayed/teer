import { type TeamRole, teamRoles } from '@/lib/team/permissions';

// Les questions/réponses sont du contenu de données (en dur dans ce fichier typé),
// pas des chaînes d'interface. Le chrome de la page (labels catégories, placeholders,
// boutons, titres) passe par messages/fr.json (namespace "support").
// Référence : décision documentée dans le plan Vague 3.

export type FAQCategory =
  | 'compte-equipe'
  | 'commandes-appels'
  | 'livraison-livreurs'
  | 'encaissement-cash'
  | 'retours-annulations'
  | 'stock-produits'
  | 'shopify-boutiques'
  | 'finances'
  | 'securite-donnees'
  | 'facturation';

export const FAQ_CATEGORY_KEYS = [
  'compte-equipe',
  'commandes-appels',
  'livraison-livreurs',
  'encaissement-cash',
  'retours-annulations',
  'stock-produits',
  'shopify-boutiques',
  'finances',
  'securite-donnees',
  'facturation',
] as const satisfies readonly FAQCategory[];

export interface FAQItem {
  id: string;
  category: FAQCategory;
  question: string;
  answer: string;
  keywords: string[];
  minRole?: TeamRole;
}

export const FAQ_ITEMS: FAQItem[] = [
  // ─── COMPTE & ÉQUIPE ───────────────────────────────────────────────────────
  {
    id: 'equipe-roles',
    category: 'compte-equipe',
    question: 'Quels sont les rôles disponibles et leurs différences ?',
    answer:
      "Il existe trois rôles. Le propriétaire a accès à tout : finances, marges, réglages, gestion de l'équipe. Le gestionnaire peut gérer les commandes, livreurs et produits, mais ne voit pas les marges ni les coûts. L'agent peut traiter les commandes (appels, statuts) mais n'a pas accès aux finances ni aux analyses avancées.",
    keywords: ['rôle', 'propriétaire', 'gestionnaire', 'agent', 'accès', 'permission', 'équipe'],
  },
  {
    id: 'equipe-inviter',
    category: 'compte-equipe',
    question: 'Comment inviter un collaborateur ?',
    answer:
      "Va dans Paramètres → Équipe, clique sur « Inviter un membre », saisis son email et choisis son rôle (gestionnaire ou agent). Il reçoit un email d'invitation avec un lien valable 7 jours. S'il n'a pas encore de compte Tëër, il en crée un en acceptant l'invitation.",
    keywords: ['inviter', 'collaborateur', 'membre', 'email', 'invitation', 'ajouter'],
  },
  {
    id: 'equipe-retirer',
    category: 'compte-equipe',
    question: "Comment retirer un membre de l'équipe ?",
    answer:
      "Dans Paramètres → Équipe, clique sur le membre à retirer et sélectionne « Retirer de l'équipe ». Ses données et actions passées restent dans le journal d'audit. Il ne peut plus accéder à votre espace Tëër.",
    keywords: ['retirer', 'supprimer', 'membre', 'équipe', 'désactiver'],
  },
  {
    id: 'equipe-mot-de-passe',
    category: 'compte-equipe',
    question: 'Comment réinitialiser mon mot de passe ?',
    answer:
      'Sur la page de connexion, clique sur « Mot de passe oublié » et saisis ton email. Tu recevras un lien de réinitialisation valable 1 heure. Si tu es déjà connecté, va dans Paramètres → Sécurité.',
    keywords: ['mot de passe', 'réinitialiser', 'oublié', 'connexion', 'sécurité'],
  },
  {
    id: 'equipe-deconnexion',
    category: 'compte-equipe',
    question: 'Pourquoi suis-je déconnecté automatiquement ?',
    answer:
      "Par mesure de sécurité, la session expire après une période d'inactivité. Reconnecte-toi normalement. Aucune donnée n'est perdue.",
    keywords: ['déconnexion', 'session', 'expirée', 'inactivité', 'connecter'],
  },
  {
    id: 'equipe-multi-boutiques',
    category: 'compte-equipe',
    question: 'Un compte peut-il gérer plusieurs boutiques ?',
    answer:
      'Oui. Un propriétaire peut connecter plusieurs boutiques Shopify au même compte Tëër. Les commandes de chaque boutique arrivent dans un flux unifié. Tu peux filtrer par boutique dans les commandes, le tableau de bord et les analyses.',
    keywords: ['multi-boutique', 'plusieurs', 'boutique', 'filtrer', 'shopify'],
  },

  // ─── COMMANDES & APPELS ───────────────────────────────────────────────────
  {
    id: 'commandes-cycle',
    category: 'commandes-appels',
    question: "Comment fonctionne le cycle de vie d'une commande COD ?",
    answer:
      "Une commande suit quatre dimensions indépendantes : l'appel (à appeler → confirmée), la livraison (non assignée → programmée → en livraison → livrée/échouée), l'encaissement (attendu → collecté → remis) et le cycle global (ouverte → terminée/annulée/retournée). On change l'état via les actions de la fiche commande ; l'assistant ne fait que consulter.",
    keywords: ['cycle', 'commande', 'COD', 'statut', 'état', 'dimensions', 'livraison', 'appel'],
  },
  {
    id: 'commandes-appels-statuts',
    category: 'commandes-appels',
    question: "À quoi servent les statuts d'appel ?",
    answer:
      'Ils tracent la prise de contact : « à appeler » (jamais contacté), « à rappeler » (tentative sans réponse), « confirmée » (le client valide la commande), « injoignable ». La confirmation déclenche une réserve de stock non bloquante.',
    keywords: ['appel', 'statut', 'à appeler', 'rappeler', 'confirmée', 'injoignable', 'contact'],
  },
  {
    id: 'commandes-confirmer',
    category: 'commandes-appels',
    question: "Comment confirmer une commande après l'appel client ?",
    answer:
      "Ouvre la fiche commande, clique sur « Confirmer » dans le menu d'actions. Le statut d'appel passe à « confirmée ». Tu peux envoyer la confirmation WhatsApp au client directement depuis la fiche.",
    keywords: ['confirmer', 'validation', 'appel', 'whatsapp', 'action', 'statut'],
  },
  {
    id: 'commandes-rappeler',
    category: 'commandes-appels',
    question: 'Comment programmer un rappel client ?',
    answer:
      "Dans la fiche commande → menu d'actions → « Journaliser un appel », choisis le résultat « À rappeler » et sélectionne la date/heure du rappel. La commande apparaîtra dans la vue « À rappeler aujourd'hui » le moment venu.",
    keywords: ['rappel', 'programmer', 'journaliser', 'appel', 'date', 'heure'],
  },
  {
    id: 'commandes-creer-manuellement',
    category: 'commandes-appels',
    question: 'Peut-on créer une commande manuellement (sans Shopify) ?',
    answer:
      'Oui. Dans la section Commandes, clique sur « Nouvelle commande » et remplis les champs (client, produits, adresse, montant). La commande créée manuellement suit le même cycle COD que les commandes Shopify.',
    keywords: ['créer', 'manuelle', 'nouvelle commande', 'sans shopify', 'saisir'],
  },
  {
    id: 'commandes-recherche',
    category: 'commandes-appels',
    question: 'Comment retrouver rapidement une commande ?',
    answer:
      'Utilise la barre de recherche en haut des commandes : elle filtre par numéro de commande, nom du client ou numéro de téléphone. Tu peux aussi filtrer par statut, période ou boutique via les filtres.',
    keywords: ['recherche', 'retrouver', 'filtre', 'numéro', 'client', 'téléphone'],
  },

  // ─── LIVRAISON & LIVREURS ─────────────────────────────────────────────────
  {
    id: 'livraison-programmer',
    category: 'livraison-livreurs',
    question: 'Comment programmer une livraison ?',
    answer:
      "Dans la fiche commande, utilise l'action « Programmer » pour définir une date de livraison. La commande passe en statut « Programmée ». Tu peux ensuite l'assigner à un livreur via « Assigner ».",
    keywords: ['programmer', 'livraison', 'date', 'planifier', 'assigner', 'livreur'],
  },
  {
    id: 'livraison-assigner',
    category: 'livraison-livreurs',
    question: 'Comment assigner une commande à un livreur ?',
    answer:
      'Dans la fiche commande, clique sur « Assigner » et sélectionne le livreur dans la liste. Le livreur reçoit (optionnellement) les détails via WhatsApp. Le stock est décrémenté à ce moment-là.',
    keywords: ['assigner', 'livreur', 'dispatch', 'affecter', 'whatsapp'],
  },
  {
    id: 'livraison-echec',
    category: 'livraison-livreurs',
    question: 'Que faire si une livraison échoue ?',
    answer:
      "Utilise l'action « Échec livraison » sur la fiche commande. Le stock revient automatiquement en inventaire. Tu peux ensuite reprogrammer une nouvelle tentative ou annuler la commande.",
    keywords: ['échec', 'livraison', 'echouée', 'retour stock', 'reprogrammer', 'tentative'],
  },
  {
    id: 'livraison-livreur-independant',
    category: 'livraison-livreurs',
    question: 'Comment gérer un livreur indépendant (non salarié) ?',
    answer:
      "Ajoute le livreur dans la section Livreurs avec son nom et numéro WhatsApp. Assigne-lui des commandes normalement. Son cash collecté et son stock en main sont suivis séparément. Les remises de cash se font depuis l'onglet Livreurs.",
    keywords: ['livreur', 'indépendant', 'freelance', 'ajouter', 'cash', 'stock'],
  },
  {
    id: 'livraison-performance',
    category: 'livraison-livreurs',
    question: "Comment voir la performance d'un livreur ?",
    answer:
      "Dans la section Livreurs, chaque livreur affiche son taux de succès (livraisons réussies/total), le cash collecté, le cash remis et le stock en main. L'assistant IA peut aussi résumer la performance sur une période donnée.",
    keywords: ['performance', 'livreur', 'taux', 'succès', 'statistiques', 'analyse'],
  },
  {
    id: 'livraison-reassigner',
    category: 'livraison-livreurs',
    question: 'Peut-on réassigner une commande à un autre livreur ?',
    answer:
      "Oui. Depuis la fiche commande, utilise l'action « Réassigner » pour changer de livreur. Le stock est transféré au nouveau livreur ; l'historique des assignations est conservé dans le journal.",
    keywords: ['réassigner', 'changer', 'livreur', 'transférer', 'reassigner'],
  },

  // ─── ENCAISSEMENT & CASH ──────────────────────────────────────────────────
  {
    id: 'cash-collecte',
    category: 'encaissement-cash',
    question: "Comment enregistrer qu'un livreur a collecté le cash ?",
    answer:
      "Quand la livraison est réussie, le livreur marque la commande comme « Livrée » et le cash est automatiquement enregistré comme « collecté » par le livreur. Le montant s'ajoute à son solde cash à remettre.",
    keywords: ['cash', 'collecté', 'encaissement', 'livreur', 'solde', 'collecte'],
  },
  {
    id: 'cash-remise',
    category: 'encaissement-cash',
    question: "Comment enregistrer la remise de cash d'un livreur ?",
    answer:
      "Dans Livreurs → sélectionne le livreur → « Enregistrer une remise ». Saisis le montant remis en F CFA. Le solde du livreur est mis à jour instantanément et l'opération est journalisée.",
    keywords: ['remise', 'cash', 'livreur', 'verser', 'payer', 'solde', 'FCFA'],
  },
  {
    id: 'cash-ecart',
    category: 'encaissement-cash',
    question: 'Que faire si le cash remis ne correspond pas au montant attendu ?',
    answer:
      "Enregistre le montant réellement remis. L'écart apparaîtra dans le solde du livreur. Il est conseillé de noter la raison de l'écart (avance, retour partiel…) dans le champ note de la remise.",
    keywords: ['écart', 'cash', 'différence', 'manquant', 'solde', 'note'],
  },
  {
    id: 'cash-montant',
    category: 'encaissement-cash',
    question: 'Pourquoi le montant à encaisser diffère parfois du total commande ?',
    answer:
      "Le montant à encaisser (cash collectable) peut différer si une remise a été accordée ou si le montant a été modifié après confirmation. C'est la valeur `cash_collectable_minor` qui fait foi, pas le total affiché.",
    keywords: ['montant', 'total', 'différence', 'remise', 'cash collectable', 'encaisser'],
  },
  {
    id: 'cash-mobile-money',
    category: 'encaissement-cash',
    question: 'Les frais de mobile money sont-ils déduits automatiquement ?',
    answer:
      'Non, ils ne sont pas déduits automatiquement du cash collecté. Ils sont saisis comme charges dans la section Finances (propriétaire). Le résultat net les retranche du CA pour le calcul de la marge nette.',
    keywords: ['mobile money', 'frais', 'wave', 'orange money', 'charges', 'déduction'],
    minRole: 'manager',
  },

  // ─── RETOURS & ANNULATIONS ────────────────────────────────────────────────
  {
    id: 'retour-rto',
    category: 'retours-annulations',
    question: 'Quelle différence entre un RTO et un retour ?',
    answer:
      "Un RTO (return-to-origin) est un échec de livraison : la commande n'a jamais été livrée. Un retour intervient après une livraison réussie. Les deux sont suivis séparément dans les analyses.",
    keywords: ['RTO', 'retour', 'return-to-origin', 'différence', 'échec', 'annulation'],
    minRole: 'manager',
  },
  {
    id: 'retour-stock',
    category: 'retours-annulations',
    question: 'Le stock revient-il en inventaire après un retour ou un échec ?',
    answer:
      "Oui. Lors d'un RTO (échec livraison) ou d'un retour validé, le stock revient automatiquement en inventaire via le registre des mouvements. Aucune action manuelle n'est nécessaire.",
    keywords: ['stock', 'retour', 'inventaire', 'mouvement', 'RTO', 'récupérer'],
  },
  {
    id: 'retour-annuler',
    category: 'retours-annulations',
    question: 'Comment annuler une commande ?',
    answer:
      "Dans la fiche commande, utilise l'action « Annuler ». La commande passe en statut « Annulée ». Si du stock avait été réservé ou sorti, le mouvement est annulé. L'annulation est définitive.",
    keywords: ['annuler', 'annulation', 'commande', 'définitif', 'status'],
  },
  {
    id: 'retour-refus-client',
    category: 'retours-annulations',
    question: 'Que faire si le client refuse la livraison à la porte ?',
    answer:
      "Utilise l'action « Refus client » sur la fiche. La commande passe en « Refusée » ; le stock revient en inventaire et le livreur ne doit pas encaisser le cash. Le taux de refus est tracé dans les analyses.",
    keywords: ['refus', 'client', 'porte', 'refusée', 'annulation', 'retour'],
  },
  {
    id: 'retour-taux',
    category: 'retours-annulations',
    question: "Où voir le taux de RTO et d'annulation ?",
    answer:
      "Dans la section Analyses, tu trouves le taux de RTO (commandes non livrées/total expédiées) et le taux d'annulation sur la période sélectionnée. L'assistant IA peut aussi te communiquer ces chiffres sur 30 jours.",
    keywords: ['taux', 'RTO', 'annulation', 'analyse', 'statistiques', 'période'],
    minRole: 'manager',
  },

  // ─── STOCK & PRODUITS ─────────────────────────────────────────────────────
  {
    id: 'stock-cump',
    category: 'stock-produits',
    question: 'Quand le stock est-il décompté et comment est calculé le coût ?',
    answer:
      "Le stock disponible n'est décrémenté qu'au moment du dispatch (assignation au livreur), pas à la confirmation (réserve souple). Le coût unitaire suit la méthode du coût moyen pondéré (CUMP), recalculé à chaque réception d'achat et figé sur chaque sortie.",
    keywords: ['stock', 'décompte', 'CUMP', 'coût', 'moyen', 'pondéré', 'dispatch', 'inventaire'],
  },
  {
    id: 'stock-seuil',
    category: 'stock-produits',
    question: 'Comment gérer les alertes de stock bas ?',
    answer:
      "Chaque produit a un seuil de stock minimum configurable. Quand le stock disponible passe en dessous, le produit apparaît dans la liste « Stock bas » du tableau de bord et dans les résultats de l'assistant IA.",
    keywords: ['stock bas', 'alerte', 'seuil', 'minimum', 'rupture', 'approvisionnement'],
  },
  {
    id: 'stock-reception',
    category: 'stock-produits',
    question: "Comment enregistrer une réception d'achat pour mettre à jour le stock ?",
    answer:
      "Dans Produits → sélectionne le produit → « Enregistrer un achat ». Saisis la quantité reçue et le coût unitaire d'achat. Le CUMP est recalculé automatiquement et le stock est mis à jour.",
    keywords: ['achat', 'réception', 'stock', 'approvisionnement', 'CUMP', 'enregistrer'],
  },
  {
    id: 'stock-cout-zero',
    category: 'stock-produits',
    question: 'Pourquoi certains produits affichent un coût de revient de 0 ?',
    answer:
      "Un produit créé sans réception d'achat a un coût unitaire de 0 par défaut. Ce n'est pas un bug — c'est l'indication que le coût est inconnu. Enregistre un achat pour corriger le CUMP. Les marges affichées pour ces produits sont à ignorer.",
    keywords: ['coût zéro', 'coût inconnu', 'marge', 'CUMP', 'produit', 'achat'],
    minRole: 'manager',
  },
  {
    id: 'stock-livreur',
    category: 'stock-produits',
    question: 'Comment suivre le stock en main chez un livreur ?',
    answer:
      "L'onglet Livreurs montre, par livreur, le stock en main (dérivé du registre des mouvements), le cash dû/collecté/remis et la performance (taux de succès). L'assistant peut résumer la performance opérationnelle sur une période.",
    keywords: ['stock', 'livreur', 'en main', 'inventaire', 'mouvement', 'suivi'],
  },

  // ─── SHOPIFY & BOUTIQUES ──────────────────────────────────────────────────
  {
    id: 'shopify-connecter',
    category: 'shopify-boutiques',
    question: 'Comment connecter ma boutique Shopify à Tëër ?',
    answer:
      "Va dans Boutiques → « Ajouter une boutique », clique sur « Connecter Shopify » et suis le flux d'autorisation OAuth. Tes commandes Shopify commenceront à arriver automatiquement dans Tëër via les webhooks.",
    keywords: ['shopify', 'connecter', 'boutique', 'oauth', 'webhooks', 'synchronisation'],
  },
  {
    id: 'shopify-sync',
    category: 'shopify-boutiques',
    question: 'Les commandes Shopify arrivent-elles en temps réel ?',
    answer:
      "Oui, via les webhooks Shopify. Chaque nouvelle commande payée (ou marquée COD) est transmise quasi instantanément. Si une commande manque, vérifie que la boutique est bien connectée dans l'onglet Boutiques.",
    keywords: ['synchronisation', 'temps réel', 'webhook', 'commande', 'shopify', 'manquante'],
  },
  {
    id: 'shopify-deconnecter',
    category: 'shopify-boutiques',
    question: 'Que se passe-t-il si je déconnecte une boutique Shopify ?',
    answer:
      'Les nouvelles commandes de cette boutique ne seront plus importées. Les commandes existantes et leur historique sont conservés dans Tëër. Tu peux reconnecter la boutique à tout moment.',
    keywords: ['déconnecter', 'boutique', 'shopify', 'supprimer', 'historique', 'reconnecter'],
  },
  {
    id: 'shopify-multi',
    category: 'shopify-boutiques',
    question: 'Peut-on connecter plusieurs boutiques Shopify ?',
    answer:
      'Oui. Tu peux connecter autant de boutiques que nécessaire. Chaque boutique a son propre flux de commandes. Tu peux filtrer par boutique dans les commandes, le tableau de bord et les analyses.',
    keywords: ['multi-boutique', 'plusieurs', 'shopify', 'boutique', 'filtrer'],
  },
  {
    id: 'shopify-produits',
    category: 'shopify-boutiques',
    question: 'Les produits Shopify sont-ils synchronisés avec le stock Tëër ?',
    answer:
      "Les produits sont importés depuis Shopify lors de la connexion et à chaque nouvelle commande (titre, SKU, variante). Le stock Tëër est géré indépendamment (CUMP) — Shopify ne met pas à jour le stock Tëër, c'est Tëër qui gère l'inventaire COD.",
    keywords: ['produits', 'shopify', 'synchroniser', 'stock', 'inventaire', 'SKU', 'variante'],
  },

  // ─── FINANCES ─────────────────────────────────────────────────────────────
  {
    id: 'finance-ca',
    category: 'finances',
    question: "Comment le chiffre d'affaires est-il calculé ?",
    answer:
      "Le CA encaissé ne compte que les commandes réellement encaissées sur la période (date d'encaissement), pas les commandes simplement marquées livrées. Les retours encaissés viennent en moins.",
    keywords: ['CA', 'chiffre affaires', 'calcul', 'encaissé', 'période', 'revenus'],
    minRole: 'manager',
  },
  {
    id: 'finance-marge',
    category: 'finances',
    question: 'Que recouvrent la marge brute et le résultat net ?',
    answer:
      'La marge brute = CA encaissé − coût des marchandises vendues (COGS au coût figé). Le résultat net retranche en plus les frais de mobile money et les charges (publicité, livreurs, loyer…). Ces chiffres sont réservés au propriétaire.',
    keywords: ['marge', 'brute', 'résultat net', 'COGS', 'coût', 'charges', 'profit'],
    minRole: 'owner',
  },
  {
    id: 'finance-cogs',
    category: 'finances',
    question: "Qu'est-ce que le COGS et comment est-il calculé ?",
    answer:
      'Le COGS (coût des marchandises vendues) est la somme des coûts unitaires figés au moment de la sortie de stock, pour toutes les commandes encaissées sur la période. Il est calculé via le CUMP.',
    keywords: ['COGS', 'coût marchandises', 'calcul', 'CUMP', 'stock', 'sortie'],
    minRole: 'owner',
  },
  {
    id: 'finance-charges',
    category: 'finances',
    question: 'Comment enregistrer des charges (publicité, loyer, frais) ?',
    answer:
      'Dans la section Finances → Charges, clique sur « Ajouter une charge ». Saisis la catégorie, le montant en F CFA et la date. Ces charges sont déduites du CA pour calculer le résultat net.',
    keywords: ['charges', 'dépenses', 'publicité', 'loyer', 'frais', 'ajouter', 'finances'],
    minRole: 'owner',
  },
  {
    id: 'finance-periode',
    category: 'finances',
    question: 'Comment changer la période des analyses financières ?',
    answer:
      'Utilise le sélecteur de période en haut des pages Finances et Analyses. Tu peux choisir des périodes prédéfinies (7 j, 30 j, 90 j) ou saisir des dates personnalisées.',
    keywords: ['période', 'date', 'filtre', 'analyses', 'finances', 'sélectionner'],
    minRole: 'manager',
  },

  // ─── SÉCURITÉ & DONNÉES ──────────────────────────────────────────────────
  {
    id: 'securite-donnees',
    category: 'securite-donnees',
    question: 'Mes données sont-elles isolées des autres marchands ?',
    answer:
      'Oui. Tëër applique un isolement strict des données par tenant (RLS Postgres). Chaque marchand ne voit que ses propres données. Les accès sont vérifiés à chaque requête au niveau base de données.',
    keywords: ['sécurité', 'données', 'isolation', 'tenant', 'RLS', 'confidentiel', 'accès'],
  },
  {
    id: 'securite-loi-sn',
    category: 'securite-donnees',
    question: 'Tëër est-il conforme à la loi sénégalaise sur les données personnelles ?',
    answer:
      'Tëër respecte les principes de la Loi 2008-12 sur la protection des données personnelles (Commission de Protection des Données Personnelles — CDP). Les données clients sont traitées uniquement pour la gestion des commandes COD.',
    keywords: ['loi', 'conformité', 'CDP', '2008-12', 'données personnelles', 'Sénégal', 'RGPD'],
  },
  {
    id: 'securite-audit',
    category: 'securite-donnees',
    question: "Existe-t-il un journal d'audit des actions ?",
    answer:
      "Oui. Toutes les transitions d'état des commandes et les appels d'outils de l'assistant IA sont journalisés avec l'identifiant de l'utilisateur, la date et l'action effectuée. Ce journal est accessible au propriétaire.",
    keywords: ['audit', 'journal', 'historique', 'action', 'traçabilité', 'utilisateur'],
  },
  {
    id: 'securite-export',
    category: 'securite-donnees',
    question: 'Peut-on exporter les données ?',
    answer:
      "L'export de données (commandes, finances) est prévu dans la feuille de route de Tëër. Pour l'instant, certaines vues proposent un export CSV partiel. Contacte le support pour une demande d'export complète.",
    keywords: ['export', 'données', 'CSV', 'télécharger', 'rapport'],
  },

  // ─── FACTURATION ─────────────────────────────────────────────────────────
  {
    id: 'facturation-abonnement',
    category: 'facturation',
    question: 'Quels sont les plans tarifaires de Tëër ?',
    answer:
      "Les informations tarifaires sont disponibles sur la page d'accueil de Tëër. Pour toute question sur l'abonnement, la facturation ou les conditions tarifaires, contacte le support via WhatsApp ou email.",
    keywords: ['tarif', 'abonnement', 'prix', 'plan', 'payer', 'facture', 'coût'],
  },
  {
    id: 'facturation-essai',
    category: 'facturation',
    question: "Y a-t-il une période d'essai gratuite ?",
    answer:
      "Pour les conditions actuelles d'accès et d'essai, contacte l'équipe Tëër via le support. Les modalités peuvent évoluer selon les offres en cours.",
    keywords: ['essai', 'gratuit', 'trial', 'période', 'test', 'démarrer'],
  },
];

const roleRank: Record<TeamRole, number> = { agent: 0, manager: 1, owner: 2 };

const KNOWN_ROLES = new Set<string>(teamRoles);

export function faqForRole(role: TeamRole): FAQItem[] {
  return FAQ_ITEMS.filter(
    (item) =>
      !item.minRole || (KNOWN_ROLES.has(item.minRole) && roleRank[role] >= roleRank[item.minRole]),
  );
}
