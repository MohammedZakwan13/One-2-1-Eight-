import type { ApiErrorBody } from '@/lib/api/schemas';

export type ApiErrorCode =
  | 'network_error'
  | 'timeout'
  | 'invalid_response'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'validation_failed'
  | 'conflict'
  | 'rate_limited'
  | 'upstream_unavailable'
  | 'server_error'
  | (string & {});

/** Error thrown by the API layer. `message` is always safe to show to a shopper. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly fieldErrors?: Record<string, string[]>;
  readonly requestId?: string;

  constructor(status: number, code: ApiErrorCode, message: string, extra: { fieldErrors?: Record<string, string[]>; requestId?: string } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fieldErrors = extra.fieldErrors;
    this.requestId = extra.requestId;
  }

  /** Safe to retry automatically (idempotent calls only). */
  get retryable() {
    return this.code === 'network_error' || this.code === 'timeout' || this.status === 502 || this.status === 503 || this.status === 504;
  }
}

const GENERIC_MESSAGES: Record<number, string> = {
  400: 'That request could not be processed. Please check your details and try again.',
  401: 'Please sign in to continue.',
  403: 'You do not have permission to do that.',
  404: 'We could not find what you were looking for.',
  409: 'That action conflicts with the current state. Please refresh and try again.',
  422: 'Some details need your attention.',
  429: 'Too many attempts. Please wait a moment and try again.',
  502: 'The store is temporarily unavailable. Please try again shortly.',
  503: 'The store is temporarily unavailable. Please try again shortly.',
  504: 'The store took too long to respond. Please try again.',
};

export function codeForStatus(status: number): ApiErrorCode {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 400 || status === 422) return 'validation_failed';
  if (status === 429) return 'rate_limited';
  if (status === 502 || status === 503 || status === 504) return 'upstream_unavailable';
  return 'server_error';
}

/** Builds an ApiError from an HTTP response without leaking raw upstream text. */
export function errorFromResponse(status: number, body: ApiErrorBody | null): ApiError {
  if (body) {
    return new ApiError(status, body.error.code || codeForStatus(status), body.error.message || GENERIC_MESSAGES[status] || 'Something went wrong.', {
      fieldErrors: body.error.fieldErrors,
      requestId: body.error.requestId,
    });
  }
  return new ApiError(status, codeForStatus(status), GENERIC_MESSAGES[status] || 'Something went wrong. Please try again.');
}

export const isApiError = (error: unknown): error is ApiError => error instanceof ApiError;
export const isUnauthorized = (error: unknown) => isApiError(error) && error.status === 401;

export function errorMessage(error: unknown, fallback = 'Something went wrong. Please try again.') {
  return isApiError(error) ? error.message : fallback;
}
