import {
  getClientErrorMessage,
  isAbortError,
  isNetworkRequestError,
} from '@/lib/monitoring/client-error-classification';
import { describe, expect, it } from 'vitest';

describe('client error classification', () => {
  it.each([
    'Load failed',
    'Failed to fetch',
    'NetworkError when attempting to fetch resource.',
    'Network request failed',
    'The network connection was lost.',
  ])('classe les erreurs réseau navigateur : %s', (message) => {
    expect(isNetworkRequestError(new TypeError(message))).toBe(true);
  });

  it('ne classe pas une erreur applicative générique comme réseau', () => {
    expect(isNetworkRequestError(new Error('Invalid search parameters'))).toBe(false);
  });

  it('reconnaît une annulation sans la confondre avec une panne réseau', () => {
    const error = new DOMException('The operation was aborted.', 'AbortError');

    expect(isAbortError(error)).toBe(true);
    expect(isNetworkRequestError(error)).toBe(false);
  });

  it('normalise les Error, chaînes et valeurs inconnues', () => {
    expect(getClientErrorMessage(new Error('boom'))).toBe('boom');
    expect(getClientErrorMessage('load failed')).toBe('load failed');
    expect(getClientErrorMessage({ message: 'hidden' })).toBe('');
  });
});
