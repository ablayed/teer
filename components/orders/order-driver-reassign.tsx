'use client';

import type { DriverOption } from '@/components/orders/transition-dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { reassignOrderDriverAction } from '@/lib/actions/orders';
import { useAction } from 'next-safe-action/hooks';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useState } from 'react';

type OrderDriverReassignProps = {
  // compact : rendu dense pour une ligne de liste (sans le titre de section).
  compact?: boolean;
  currentDriverId: string | null;
  deliveryState: string | null;
  drivers: DriverOption[];
  orderId: string;
};

// États où une réassignation est permise (jamais après livraison / clôture).
// Miroir de la garde SQL reassign_order_driver (0058).
const REASSIGNABLE_STATES = ['scheduled', 'assigned', 'out_for_delivery'];

export function OrderDriverReassign({
  compact = false,
  currentDriverId,
  deliveryState,
  drivers,
  orderId,
}: OrderDriverReassignProps) {
  const fieldId = useId();
  const router = useRouter();
  const reassign = useAction(reassignOrderDriverAction);
  const [picking, setPicking] = useState(false);
  const [nextDriverId, setNextDriverId] = useState('');
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'error'; message: string } | null>(
    null,
  );

  useEffect(() => {
    const result = reassign.result.data;
    if (!result) {
      return;
    }
    if (result.ok) {
      setFeedback({ tone: 'success', message: 'Livreur réassigné.' });
      setPicking(false);
      setNextDriverId('');
      router.refresh();
      return;
    }
    setFeedback({ tone: 'error', message: result.message ?? 'La réassignation a échoué.' });
  }, [router, reassign.result.data]);

  const reassignable = deliveryState !== null && REASSIGNABLE_STATES.includes(deliveryState);
  // Un livreur courant est requis pour parler de « réassignation » (sinon c'est une
  // première assignation, gérée par l'action « Assigner »).
  if (!reassignable || !currentDriverId) {
    return null;
  }

  const currentDriver = drivers.find((driver) => driver.id === currentDriverId);
  const otherDrivers = drivers.filter((driver) => driver.id !== currentDriverId);

  function handleConfirm() {
    if (!nextDriverId || nextDriverId === currentDriverId) {
      return;
    }
    setFeedback(null);
    reassign.execute({ orderId, newDriverId: nextDriverId });
  }

  return (
    <section className="w-full space-y-3">
      {compact ? null : <h2 className="text-sm font-semibold uppercase text-muted">Livreur</h2>}

      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-text">
          Affecté à{' '}
          <span className="font-semibold">{currentDriver?.fullName ?? 'Livreur inconnu'}</span>
        </p>
        {picking ? null : (
          <Button
            className="min-h-10 border border-border bg-surface hover:border-accent/40 hover:bg-accent-subtle hover:text-text"
            onClick={() => {
              setFeedback(null);
              setPicking(true);
            }}
            size="sm"
            type="button"
            variant="secondary"
          >
            Changer le livreur
          </Button>
        )}
      </div>

      {picking ? (
        <div className="space-y-3 rounded-lg border border-border p-4">
          {otherDrivers.length === 0 ? (
            <p className="text-sm text-muted">
              Aucun autre livreur actif. Ajoutez-en un dans Paramètres &gt; Équipe.
            </p>
          ) : (
            <div className="space-y-2">
              <Label htmlFor={fieldId}>Nouveau livreur</Label>
              <select
                className="h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm text-text shadow-1 transition focus:border-accent"
                id={fieldId}
                onChange={(event) => setNextDriverId(event.target.value)}
                value={nextDriverId}
              >
                <option value="">Choisir un livreur…</option>
                {otherDrivers.map((driver) => (
                  <option key={driver.id} value={driver.id}>
                    {driver.fullName}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button
              onClick={() => {
                setPicking(false);
                setNextDriverId('');
                setFeedback(null);
              }}
              size="sm"
              type="button"
              variant="ghost"
            >
              Annuler
            </Button>
            <Button
              disabled={!nextDriverId || reassign.isExecuting}
              onClick={handleConfirm}
              size="sm"
              type="button"
              variant="primary"
            >
              Réassigner
            </Button>
          </div>
        </div>
      ) : null}

      {feedback ? (
        <p
          className={`text-sm font-medium ${feedback.tone === 'success' ? 'text-success' : 'text-danger'}`}
          role={feedback.tone === 'error' ? 'alert' : 'status'}
        >
          {feedback.message}
        </p>
      ) : null}
    </section>
  );
}
