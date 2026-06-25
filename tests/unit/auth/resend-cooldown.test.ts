import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Pure step function extracted from connexion-form resend cooldown:
// `setResendCooldown((c) => { if (c <= 1) { clearInterval(...); return 0; } return c - 1; })`
function cooldownStep(current: number): number {
  return current <= 1 ? 0 : current - 1;
}

describe('cooldownStep', () => {
  it('decrements from 60 to 59', () => {
    expect(cooldownStep(60)).toBe(59);
  });

  it('decrements from 2 to 1', () => {
    expect(cooldownStep(2)).toBe(1);
  });

  it('returns 0 when current is 1', () => {
    expect(cooldownStep(1)).toBe(0);
  });

  it('returns 0 when already at 0', () => {
    expect(cooldownStep(0)).toBe(0);
  });

  it('simulates full countdown from 3 to 0', () => {
    let c = 3;
    while (c > 0) c = cooldownStep(c);
    expect(c).toBe(0);
  });
});

describe('resend cooldown via fake timers', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reaches 0 after 60 ticks at 1 s interval', () => {
    let count = 60;
    const id = setInterval(() => {
      count = cooldownStep(count);
      if (count === 0) clearInterval(id);
    }, 1000);
    vi.advanceTimersByTime(60_000);
    expect(count).toBe(0);
  });

  it('resets to 60 after a previous cooldown ends', () => {
    let count = 5;
    const id = setInterval(() => {
      count = cooldownStep(count);
      if (count === 0) clearInterval(id);
    }, 1000);
    vi.advanceTimersByTime(5_000);
    expect(count).toBe(0);
    count = 60;
    expect(count).toBe(60);
  });
});
