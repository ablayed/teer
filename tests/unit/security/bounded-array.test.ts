import { boundedArray } from '@/lib/security/bounded-array';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

describe('existing Zod 3 collection bounds before element parsing', () => {
  it('keeps valid inputs, element transformations and array input types', () => {
    const schema = boundedArray(z.string().trim(), { min: 1, max: 2 });
    expectTypeOf<z.input<typeof schema>>().toEqualTypeOf<string[]>();
    expect(schema.parse([' one ', 'two'])).toEqual(['one', 'two']);
  });
  it('rejects three ordinary values before any element refinement', () => {
    let parsed = 0;
    const schema = boundedArray(
      z.string().refine(() => {
        parsed++;
        return true;
      }),
      { max: 2 },
    );
    const result = schema.safeParse(['one', 'two', 'three']);
    expect(result.success).toBe(false);
    expect(parsed).toBe(0);
    if (!result.success) expect(result.error.issues).toHaveLength(1);
  });
  it('preserves the native maximum message and nested path', () => {
    const value = { items: ['one', 'two', 'three'] };
    const native = z.object({ items: z.array(z.string()).max(2) }).safeParse(value);
    const guarded = z.object({ items: boundedArray(z.string(), { max: 2 }) }).safeParse(value);
    expect(native.success).toBe(false);
    expect(guarded.success).toBe(false);
    if (!native.success && !guarded.success) {
      expect(guarded.error.issues[0].message).toBe(native.error.issues[0].message);
      expect(guarded.error.issues[0].path).toEqual(native.error.issues[0].path);
    }
  });
  it('keeps minimum and ordinary element errors', () => {
    const schema = boundedArray(z.string(), { min: 1, max: 2 });
    expect(schema.safeParse([]).success).toBe(false);
    expect(schema.safeParse([1]).success).toBe(false);
  });
  it('keeps native invalid-type validation for non-arrays', () => {
    const native = z.array(z.string()).max(2).safeParse('one');
    const guarded = boundedArray(z.string(), { max: 2 }).safeParse('one');
    expect(guarded.success).toBe(false);
    if (!native.success && !guarded.success)
      expect(guarded.error.issues).toEqual(native.error.issues);
  });
  it('supports asynchronous element validation within the limit', async () => {
    const schema = boundedArray(
      z.string().refine(async () => true),
      { max: 2 },
    );
    expect(await schema.parseAsync(['one'])).toEqual(['one']);
  });
});
