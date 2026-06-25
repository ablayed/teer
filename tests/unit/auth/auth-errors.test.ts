import { mapSupabaseAuthError } from '@/lib/actions/auth-errors';
import { describe, expect, it } from 'vitest';

describe('mapSupabaseAuthError', () => {
  it('maps invalid_credentials code', () => {
    expect(mapSupabaseAuthError({ code: 'invalid_credentials' })).toBe('invalid_credentials');
  });

  it('maps "invalid login credentials" message', () => {
    expect(mapSupabaseAuthError({ message: 'Invalid login credentials' })).toBe(
      'invalid_credentials',
    );
  });

  it('maps over_email_send_rate_limit to rate_limited', () => {
    expect(mapSupabaseAuthError({ code: 'over_email_send_rate_limit' })).toBe('rate_limited');
  });

  it('maps over_request_rate_limit to rate_limited', () => {
    expect(mapSupabaseAuthError({ code: 'over_request_rate_limit' })).toBe('rate_limited');
  });

  it('maps HTTP 429 to rate_limited', () => {
    expect(mapSupabaseAuthError({ status: 429 })).toBe('rate_limited');
  });

  it('maps email_not_confirmed code', () => {
    expect(mapSupabaseAuthError({ code: 'email_not_confirmed' })).toBe('email_not_confirmed');
  });

  it('maps "email not confirmed" message', () => {
    expect(mapSupabaseAuthError({ message: 'Email not confirmed' })).toBe('email_not_confirmed');
  });

  it('maps user_already_exists to email_already_registered', () => {
    expect(mapSupabaseAuthError({ code: 'user_already_exists' })).toBe('email_already_registered');
  });

  it('maps "already registered" message to email_already_registered', () => {
    expect(mapSupabaseAuthError({ message: 'User already registered' })).toBe(
      'email_already_registered',
    );
  });

  it('maps weak_password code', () => {
    expect(mapSupabaseAuthError({ code: 'weak_password' })).toBe('weak_password');
  });

  it('falls back to unknown for unrecognised errors', () => {
    expect(mapSupabaseAuthError({ code: 'some_new_code', message: 'Something went wrong' })).toBe(
      'unknown',
    );
  });

  it('falls back to unknown for empty error', () => {
    expect(mapSupabaseAuthError({})).toBe('unknown');
  });
});
