import {
  cancelReasonValues,
  paymentChannelsAtDelivery,
  transitionActions,
} from '@/lib/domain/order-transition-actions';
import { z } from 'zod';

export const transitionInputSchema = z
  .object({
    action: z.enum(transitionActions),
    orderId: z.string().uuid(),
    payload: z
      .object({
        note: z.string().trim().max(500).optional(),
        assignedDriverId: z.string().uuid().optional(),
        // 0114 — deux dates éditables indépendantes. Les bornes métier (pas dans le
        // futur, pas avant la création, confirmation ≤ livraison) sont validées par
        // transition_order, pas ici : elles dépendent de la commande en base, que ce
        // schéma ne lit pas. Zod ne garantit ici que le format ISO.
        callConfirmedAt: z.string().datetime().optional(),
        cancelReason: z.string().trim().max(500).optional(),
        deliveredAt: z.string().datetime().optional(),
        // Lot B : raisons d'annulation multiples, allow-list stricte.
        cancelReasons: z.array(z.enum(cancelReasonValues)).min(1).max(5).optional(),
        nextContactAt: z.string().datetime().optional(),
        paymentChannelAtDelivery: z.enum(paymentChannelsAtDelivery).optional(),
        scheduledFor: z.string().datetime().optional(),
      })
      .optional(),
  })
  .superRefine((input, ctx) => {
    if (input.action !== 'annuler') {
      return;
    }

    if (!input.payload?.cancelReasons || input.payload.cancelReasons.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Sélectionnez au moins une raison d'annulation.",
        path: ['payload', 'cancelReasons'],
      });
    }
  });
