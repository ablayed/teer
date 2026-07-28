// Sujet 1.1 — visibilité de la date/heure de livraison programmée.
//
// `scheduled_for` était écrit par « Programmer »/« Reprogrammer »/le popup
// d'assignation mais n'était RENDU nulle part : seul owner/manager pouvait le
// relire en rouvrant le modal « Modifier les montants ». Ce module centralise la
// règle « cette commande a-t-elle une date de livraison pertinente à afficher ».
//
// Rappel (migration 0096) : `scheduled_for` pilote `cash_collected_at` pour toute
// commande programmée puis livrée — c'est une donnée financièrement significative,
// pas un simple confort d'affichage.

// États de livraison où une date/heure de livraison a un sens. Identique à la liste
// qui gouverne l'édition (`OrderAmountsEditor`) : un `scheduled_for` résiduel sur une
// commande livrée/annulée/retournée n'est PAS affiché (valeur historique, non pilotable).
export const SCHEDULED_DELIVERY_STATES = ['scheduled', 'assigned', 'out_for_delivery'] as const;

type ScheduledDeliveryShape = {
  deliveryState: string | null;
  scheduledFor: string | null;
};

export function hasVisibleScheduledDelivery(order: ScheduledDeliveryShape): boolean {
  if (!order.scheduledFor || order.deliveryState === null) {
    return false;
  }

  return (SCHEDULED_DELIVERY_STATES as readonly string[]).includes(order.deliveryState);
}
