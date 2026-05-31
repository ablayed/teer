import { z } from 'zod';

export const callOutcomes = ['CONFIRMEE', 'SANS_REPONSE', 'A_RAPPELER', 'REFUSEE'] as const;

export type CallOutcome = (typeof callOutcomes)[number];

export const callRescheduleMessages = {
  required: "Indiquez la date et l'heure du rappel.",
  missingTime: "Pr\u00e9cisez aussi l'heure du rappel.",
  future: 'La date du rappel doit \u00eatre dans le futur.',
} as const;

type CallNextActionAtValidation =
  | {
      ok: true;
      iso: string;
    }
  | {
      ok: false;
      message: string;
    };

const dateOnlyPattern = /^\d{4}-\d{2}-\d{2}$/;
const dateWithoutCompleteTimePattern = /^\d{4}-\d{2}-\d{2}T?\d{0,2}:?\d{0,1}$/;

function hasDateWithoutCompleteTime(value: string): boolean {
  return dateOnlyPattern.test(value) || dateWithoutCompleteTimePattern.test(value);
}

export function validateCallNextActionAt(
  value: string | undefined,
  now = new Date(),
): CallNextActionAtValidation {
  const trimmedValue = value?.trim() ?? '';

  if (!trimmedValue) {
    return { ok: false, message: callRescheduleMessages.required };
  }

  if (hasDateWithoutCompleteTime(trimmedValue)) {
    return { ok: false, message: callRescheduleMessages.missingTime };
  }

  const date = new Date(trimmedValue);

  if (Number.isNaN(date.getTime())) {
    return { ok: false, message: callRescheduleMessages.required };
  }

  if (date.getTime() <= now.getTime()) {
    return { ok: false, message: callRescheduleMessages.future };
  }

  return { ok: true, iso: date.toISOString() };
}

export const logCallInputSchema = z
  .object({
    orderId: z.string().uuid(),
    outcome: z.enum(callOutcomes),
    note: z.string().trim().max(500).optional(),
    nextActionAt: z.string().optional(),
  })
  .superRefine((input, ctx) => {
    if (input.outcome !== 'A_RAPPELER') {
      return;
    }

    const validation = validateCallNextActionAt(input.nextActionAt);

    if (!validation.ok) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: validation.message,
        path: ['nextActionAt'],
      });
    }
  })
  .transform((input) => {
    if (input.outcome !== 'A_RAPPELER') {
      return { ...input, nextActionAt: undefined };
    }

    const validation = validateCallNextActionAt(input.nextActionAt);

    return {
      ...input,
      nextActionAt: validation.ok ? validation.iso : input.nextActionAt,
    };
  });
