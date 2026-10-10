import { isLastOwnerViolation, teamErrorMessageKey } from '@/lib/team/last-owner';
import { describe, expect, it } from 'vitest';

describe('garde du dernier owner — lecture du refus de la base', () => {
  it('reconnaît le refus du trigger : 23514 ET message last_owner', () => {
    expect(isLastOwnerViolation({ code: '23514', message: 'last_owner' })).toBe(true);
  });

  it('ne confond pas avec une contrainte CHECK, qui porte le même code', () => {
    expect(
      isLastOwnerViolation({
        code: '23514',
        message:
          'new row for relation "merchant_member" violates check constraint "merchant_member_role_check"',
      }),
    ).toBe(false);
  });

  it('ne reconnaît ni un autre code, ni une erreur absente', () => {
    expect(isLastOwnerViolation({ code: '42501', message: 'last_owner' })).toBe(false);
    expect(isLastOwnerViolation(null)).toBe(false);
    expect(isLastOwnerViolation(undefined)).toBe(false);
    expect(isLastOwnerViolation({})).toBe(false);
  });
});

describe('message affiché pour un refus d action d équipe', () => {
  it('nomme le refus du dernier owner', () => {
    expect(teamErrorMessageKey('last_owner')).toBe('errors.last_owner');
  });

  it('reste générique pour tout autre refus', () => {
    for (const code of ['update_failed', 'forbidden', 'audit_failed', 'member_not_found', null]) {
      expect(teamErrorMessageKey(code)).toBe('errors.generic');
    }
    expect(teamErrorMessageKey(undefined)).toBe('errors.generic');
  });
});
