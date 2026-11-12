export function classifyAuthorization({ expected, observed, status, contractDenied }) {
  if (!expected && observed) return 'VIOLATION_CONFIRMED';
  if (status >= 500) return 'INDETERMINATE_PROCESSING_ERROR';
  if (expected && observed && status >= 200 && status < 300) return 'AUTHORIZATION_CONFIRMED';
  if (!expected && !observed && contractDenied) return 'DENIAL_CONFIRMED';
  return 'INDETERMINATE_CONTRACT_EVIDENCE';
}
