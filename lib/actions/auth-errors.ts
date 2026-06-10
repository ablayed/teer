export const AUTH_ERROR_CODES = {
  invalid_credentials: 'invalid_credentials',
  email_already_registered: 'email_already_registered',
  rate_limited: 'rate_limited',
  email_not_confirmed: 'email_not_confirmed',
  weak_password: 'weak_password',
  legal_consent_required: 'legal_consent_required',
  legal_documents_unavailable: 'legal_documents_unavailable',
  consent_record_failed: 'consent_record_failed',
  unknown: 'unknown',
} as const;

export type AuthErrorCode = keyof typeof AUTH_ERROR_CODES;

export function mapSupabaseAuthError(supabaseError: {
  message?: string;
  code?: string;
  status?: number;
}): AuthErrorCode {
  const msg = (supabaseError.message ?? '').toLowerCase();
  const code = (supabaseError.code ?? '').toLowerCase();
  const status = supabaseError.status ?? 0;

  if (code === 'invalid_credentials' || msg.includes('invalid login credentials')) {
    return 'invalid_credentials';
  }

  if (
    code === 'user_already_exists' ||
    msg.includes('already registered') ||
    msg.includes('user already registered')
  ) {
    return 'email_already_registered';
  }

  if (
    code === 'over_email_send_rate_limit' ||
    code === 'over_request_rate_limit' ||
    status === 429 ||
    msg.includes('rate limit') ||
    msg.includes('too many requests') ||
    msg.includes('for security purposes')
  ) {
    return 'rate_limited';
  }

  if (code === 'email_not_confirmed' || msg.includes('email not confirmed')) {
    return 'email_not_confirmed';
  }

  if (code === 'weak_password' || msg.includes('password should be at least')) {
    return 'weak_password';
  }

  return 'unknown';
}
