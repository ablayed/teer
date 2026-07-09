export type ReadonlyMetricResult<T> = { ok: true; data: T } | { ok: false; errorCode: string };

export type MetricLoadState<T> =
  | { status: 'loading' }
  | { status: 'error'; errorCode: string }
  | { status: 'empty'; data: T }
  | { status: 'ready'; data: T };

export function toMetricLoadState<T>(
  result: ReadonlyMetricResult<T> | null | undefined,
  isEmpty: (data: T) => boolean,
): MetricLoadState<T> {
  if (!result) {
    return { status: 'loading' };
  }

  if (!result.ok) {
    return { status: 'error', errorCode: result.errorCode };
  }

  if (isEmpty(result.data)) {
    return { status: 'empty', data: result.data };
  }

  return { status: 'ready', data: result.data };
}
