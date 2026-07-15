const NETWORK_REQUEST_ERROR_PATTERN =
  /(?:load failed|failed to fetch|networkerror when attempting to fetch resource|network request failed|the network connection was lost)/i;

export function getClientErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return typeof error === 'string' ? error : '';
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : error instanceof Error && error.name === 'AbortError';
}

export function isNetworkRequestError(error: unknown): boolean {
  return NETWORK_REQUEST_ERROR_PATTERN.test(getClientErrorMessage(error));
}
