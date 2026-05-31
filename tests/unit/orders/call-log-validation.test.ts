import { callRescheduleMessages, logCallInputSchema } from '@/lib/orders/call-log-validation';
import { describe, expect, it } from 'vitest';

const validOrderId = '00000000-0000-4000-8000-000000000001';

function nextActionAtError(input: { outcome: 'A_RAPPELER'; nextActionAt?: string }): string | null {
  const result = logCallInputSchema.safeParse({
    orderId: validOrderId,
    ...input,
  });

  if (result.success) {
    return null;
  }

  return result.error.issues.find((issue) => issue.path[0] === 'nextActionAt')?.message ?? null;
}

describe('call log nextActionAt validation', () => {
  it('requires date and time for a callback outcome', () => {
    expect(nextActionAtError({ outcome: 'A_RAPPELER' })).toBe(callRescheduleMessages.required);
  });

  it('reports a missing time when only the date is provided', () => {
    expect(nextActionAtError({ outcome: 'A_RAPPELER', nextActionAt: '2099-01-01' })).toBe(
      callRescheduleMessages.missingTime,
    );
  });

  it('rejects a callback date in the past', () => {
    expect(nextActionAtError({ outcome: 'A_RAPPELER', nextActionAt: '2000-01-01T10:30' })).toBe(
      callRescheduleMessages.future,
    );
  });

  it('accepts a future callback date and normalizes it', () => {
    const result = logCallInputSchema.safeParse({
      orderId: validOrderId,
      outcome: 'A_RAPPELER',
      nextActionAt: '2099-01-01T10:30',
    });

    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.data.nextActionAt).toBe(new Date('2099-01-01T10:30').toISOString());
    }
  });
});
