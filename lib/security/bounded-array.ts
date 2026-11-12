import { z } from 'zod';

/** Enforce an existing array maximum before parsing any element with Zod 3. */
export function boundedArray<T extends z.ZodTypeAny>(
  element: T,
  limits: { max: number; min?: number },
): z.ZodEffects<z.ZodArray<T>, z.output<T>[], z.input<T>[]> {
  let array = z.array(element).max(limits.max);
  if (limits.min !== undefined) array = array.min(limits.min);
  const guarded = z.preprocess((value, ctx) => {
    if (Array.isArray(value) && value.length > limits.max) {
      ctx.addIssue({
        code: z.ZodIssueCode.too_big,
        maximum: limits.max,
        type: 'array',
        inclusive: true,
        exact: false,
        fatal: true,
      });
      return z.NEVER;
    }
    return value;
  }, array);
  // This preprocessor only rejects; it never transforms a permitted input.
  // Preserve the original array input type rather than widening action inputs to unknown.
  return guarded as z.ZodEffects<z.ZodArray<T>, z.output<T>[], z.input<T>[]>;
}
