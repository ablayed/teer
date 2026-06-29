'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { getOrderAmountsForAssignmentAction, updateOrderAmountsAction } from '@/lib/actions/orders';
import { type TransitionResult, performTransition } from '@/lib/actions/transitions';
import {
  dateTimeInputsToIso,
  isoToDateTimeInputs,
  nextWholeHourInputs,
  normalizeHourInput,
} from '@/lib/format/datetime-input';
import { formatMoney } from '@/lib/format/fcfa';
import {
  buildWhatsappShareUrl,
  formatMoneyForWhatsApp,
  formatProduits,
  parseItemsSummaryForWhatsapp,
  safeText,
} from '@/lib/whatsapp/format';
import { useTranslations } from 'next-intl';
import { useAction } from 'next-safe-action/hooks';
import { useEffect, useId, useState } from 'react';

type TransitionSuccess = Extract<TransitionResult, { ok: true }>;

type AssignmentDetailsDialogProps = {
  // Phase 13.1 — livreur CHOISI dans le picker mais PAS encore assigné : le popup
  // exécutera `assigner`(+driver, dispatch) puis `demarrer_livraison` au clic. Null/absent =
  // commande DÉJÀ assignée (réouverture) → seulement `demarrer_livraison`.
  driverIdToAssign?: string | null;
  onClose: () => void;
  // Appelé après le passage en livraison réussi, avec le résultat de transition pour
  // mettre à jour la liste/le détail.
  onConfirmed: (result: TransitionSuccess) => void;
  orderId: string;
};

// Phase 11.1 (option C) + Phase 13.1 — popup d'assignation : s'ouvre APRÈS le choix du
// livreur (le picker NE déclenche plus la transition) et à la réouverture d'une commande
// assignée. Affiche les détails (lecture) + montants modifiables. « Envoyer au livreur
// (WhatsApp) » = save montants (si modifié) → assigner(+driver, dispatch) si le livreur
// n'est pas encore assigné → demarrer_livraison → WhatsApp → fermeture. Annuler/Échap →
// AUCUNE transition : la commande reste « Programmée » (scheduled), sans livreur ni dispatch.
export function AssignmentDetailsDialog({
  driverIdToAssign,
  onClose,
  onConfirmed,
  orderId,
}: AssignmentDetailsDialogProps) {
  const t = useTranslations('whatsapp');
  const fieldId = useId();
  const fetchDetails = useAction(getOrderAmountsForAssignmentAction);
  const update = useAction(updateOrderAmountsAction);
  const startDelivery = useAction(performTransition);

  const [loaded, setLoaded] = useState(false);
  const [orderNumber, setOrderNumber] = useState<string | null>(null);
  const [customerName, setCustomerName] = useState<string | null>(null);
  const [customerPhone, setCustomerPhone] = useState<string | null>(null);
  const [deliveryAddress, setDeliveryAddress] = useState<string | null>(null);
  const [currency, setCurrency] = useState<string | null>(null);
  const [driverMessage, setDriverMessage] = useState('');
  const [items, setItems] = useState<{ title: string; quantity: number; price: number }[]>([]);
  const [savedTotal, setSavedTotal] = useState(0);
  const [savedFee, setSavedFee] = useState(0);
  const [savedScheduledFor, setSavedScheduledFor] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [feeInput, setFeeInput] = useState('');
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [feedback, setFeedback] = useState<string | null>(null);

  const isExecuting = update.isExecuting || startDelivery.isExecuting;

  // Chargement initial des montants/détails (la LISTE ne porte pas delivery_fee_minor).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await fetchDetails.executeAsync({
        orderId,
        ...(driverIdToAssign ? { driverId: driverIdToAssign } : {}),
      });
      if (cancelled) {
        return;
      }
      if (!result?.data?.ok) {
        setFeedback('Impossible de charger les détails de la commande.');
        return;
      }
      const d = result.data.data;
      setOrderNumber(d.orderNumber);
      setCustomerName(d.customerName);
      setCustomerPhone(d.customerPhone);
      setDeliveryAddress(d.deliveryAddress);
      setCurrency(d.currency);
      setItems(d.items);
      setSavedTotal(d.totalAmount);
      setSavedFee(d.deliveryFeeMinor);
      setSavedScheduledFor(d.scheduledFor);
      setTotal(d.totalAmount);
      setFeeInput(d.deliveryFeeMinor > 0 ? String(d.deliveryFeeMinor) : '');
      const dt = d.scheduledFor ? isoToDateTimeInputs(d.scheduledFor) : nextWholeHourInputs();
      setDate(dt.date);
      setTime(normalizeHourInput(dt.time));
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
    // orderId/driverIdToAssign stables pour la durée de vie du popup ; executeAsync mémoïsé.
  }, [orderId, driverIdToAssign, fetchDetails.executeAsync]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !isExecuting) {
        onClose();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isExecuting, onClose]);

  // Reconstruit le message quand le total édité change — la valeur courante doit
  // toujours être reflétée dans l'URL WhatsApp finale.
  useEffect(() => {
    if (!loaded) return;
    setDriverMessage(
      t('livreur', {
        numeroCommande: safeText(orderNumber),
        telephone: safeText(customerPhone),
        produits: formatProduits(items.map((i) => ({ nom: i.title, quantite: i.quantity }))),
        adresse: safeText(deliveryAddress),
        total: formatMoneyForWhatsApp(total),
      }),
    );
  }, [loaded, total, t, orderNumber, customerPhone, items, deliveryAddress]);

  const parsedFee = feeInput === '' ? 0 : Number(feeInput);
  const fee = Number.isFinite(parsedFee) ? parsedFee : 0;
  const netMinor = Math.max(total - fee, 0);
  const totalValid = Number.isFinite(total) && total >= 0;
  const feeValid = Number.isFinite(parsedFee) && parsedFee >= 0;
  const canConfirm = loaded && totalValid && feeValid && !isExecuting;

  // « Envoyer au livreur (WhatsApp) » : un clic = save montants (si modifiés) → assigner
  // (+driver, dispatch) si le livreur n'est pas encore assigné → demarrer_livraison →
  // ouverture WhatsApp. L'onglet est PRÉ-OUVERT synchrone (sinon Safari bloque window.open
  // après un await). C'est SEULEMENT ici que la commande est assignée.
  async function handleConfirm() {
    if (!canConfirm) {
      return;
    }
    setFeedback(null);

    const roundedTotal = Math.round(total);
    const roundedFee = Math.round(fee);
    const scheduledForIso = dateTimeInputsToIso(date, time);
    // Pré-ouverture synchrone obligatoire avant tout await (popup-blocker Safari).
    const whatsappUrl = buildWhatsappShareUrl(driverMessage);
    const whatsappWindow = window.open('', '_blank');

    const amountsChanged =
      roundedTotal !== savedTotal ||
      roundedFee !== savedFee ||
      (scheduledForIso !== null && scheduledForIso !== savedScheduledFor);

    if (amountsChanged) {
      const saved = await update.executeAsync({
        orderId,
        totalAmount: roundedTotal,
        deliveryFeeMinor: roundedFee,
        ...(scheduledForIso ? { scheduledFor: scheduledForIso } : {}),
      });
      if (!saved?.data?.ok) {
        whatsappWindow?.close();
        setFeedback('La mise à jour des montants a échoué.');
        return;
      }
    }

    // Assignation différée : c'est le clic « Envoyer au livreur » qui assigne (et poste le
    // dispatch), pas le picker. Sauté à la réouverture d'une commande déjà assignée.
    if (driverIdToAssign) {
      const assigned = await startDelivery.executeAsync({
        orderId,
        action: 'assigner',
        payload: { assignedDriverId: driverIdToAssign },
      });
      if (!assigned?.data?.ok) {
        whatsappWindow?.close();
        const message =
          assigned?.data && 'message' in assigned.data && typeof assigned.data.message === 'string'
            ? assigned.data.message
            : "L'assignation au livreur a échoué.";
        setFeedback(message);
        return;
      }
    }

    const started = await startDelivery.executeAsync({ orderId, action: 'demarrer_livraison' });
    if (!started?.data?.ok) {
      whatsappWindow?.close();
      const message =
        started?.data && 'message' in started.data && typeof started.data.message === 'string'
          ? started.data.message
          : 'Le passage en livraison a échoué.';
      setFeedback(message);
      return;
    }

    if (whatsappWindow) {
      whatsappWindow.location.href = whatsappUrl;
    }

    onConfirmed(started.data);
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center">
      <dialog
        aria-label="Détails de la livraison"
        aria-modal="true"
        className="m-0 max-h-[90dvh] w-full max-w-md space-y-4 overflow-y-auto rounded-lg border border-border bg-surface p-5 text-text shadow-2"
        open
      >
        <header className="space-y-1">
          <h2 className="text-lg font-semibold">Détails de la livraison</h2>
          <p className="text-sm text-muted">
            {(orderNumber ?? '—') + (customerName ? ` · ${customerName}` : '')}
          </p>
        </header>

        {!loaded ? (
          <p className="py-6 text-center text-sm text-muted">Chargement…</p>
        ) : (
          <>
            {items.length > 0 ? (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {items.map((item, index) => (
                  <li
                    className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
                    key={`${item.title}-${index}`}
                  >
                    <span className="min-w-0 truncate">
                      {item.quantity} × {item.title || '—'}
                    </span>
                    <span className="shrink-0 font-mono tabular-nums">
                      {formatMoney(item.quantity * item.price, currency)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}

            <div className="space-y-2">
              <Label htmlFor={`${fieldId}-total`}>Total</Label>
              <Input
                id={`${fieldId}-total`}
                inputMode="numeric"
                min={0}
                onChange={(event) => setTotal(Number(event.target.value))}
                type="number"
                value={Number.isFinite(total) ? total : ''}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor={`${fieldId}-fee`}>Frais de livraison</Label>
              <Input
                id={`${fieldId}-fee`}
                inputMode="numeric"
                min={0}
                onChange={(event) => setFeeInput(event.target.value)}
                placeholder="Frais de livraison"
                type="number"
                value={feeInput}
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor={`${fieldId}-date`}>Date de livraison</Label>
                <Input
                  id={`${fieldId}-date`}
                  onChange={(event) => setDate(event.target.value)}
                  type="date"
                  value={date}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor={`${fieldId}-time`}>Heure de livraison</Label>
                <Input
                  id={`${fieldId}-time`}
                  onChange={(event) => setTime(normalizeHourInput(event.target.value))}
                  step={3600}
                  type="time"
                  value={time}
                />
              </div>
            </div>

            <p className="text-sm text-muted">
              Net (hors livraison) :{' '}
              <span className="font-mono font-semibold tabular-nums text-text">
                {formatMoney(netMinor, currency)}
              </span>
            </p>

            <div className="space-y-2">
              <Label htmlFor={`${fieldId}-driver-msg`}>Message livreur (WhatsApp)</Label>
              <textarea
                className="w-full min-h-[160px] rounded-md border border-input bg-background px-3 py-2 text-sm"
                id={`${fieldId}-driver-msg`}
                onChange={(e) => setDriverMessage(e.target.value)}
                value={driverMessage}
              />
            </div>
          </>
        )}

        {feedback ? (
          <p className="text-sm font-medium text-danger" role="alert">
            {feedback}
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button disabled={isExecuting} onClick={onClose} size="sm" type="button" variant="ghost">
            Annuler
          </Button>
          <Button
            disabled={!canConfirm}
            onClick={handleConfirm}
            size="sm"
            type="button"
            variant="primary"
          >
            Envoyer au livreur (WhatsApp)
          </Button>
        </div>
      </dialog>
    </div>
  );
}
