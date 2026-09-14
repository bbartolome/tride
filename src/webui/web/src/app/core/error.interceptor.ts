import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { catchError, throwError } from 'rxjs';
import { ErrorEnvelope } from './api.types';

/**
 * Typed error thrown by every `ApiClient` call. The server's
 * `AppExceptionFilter` (see `common/app-exception.filter.ts` in the API
 * package) guarantees the `{code, message, detail?}` envelope on every
 * non-2xx response, so `code`/`message` are always populated here — this
 * interceptor's only job is unwrapping that envelope out of
 * `HttpErrorResponse.error` and falling back sanely for the rare case the
 * envelope itself didn't arrive (network failure, a proxy/gateway error
 * that never reached Nest, or a non-JSON body).
 */
export interface ApiError {
  status: number;
  code: string;
  message: string;
  detail?: unknown;
}

function isErrorEnvelope(body: unknown): body is ErrorEnvelope {
  if (typeof body !== 'object' || body === null) {
    return false;
  }
  const record = body as Record<string, unknown>;
  return (
    typeof record['code'] === 'string' && typeof record['message'] === 'string'
  );
}

function toApiError(err: HttpErrorResponse): ApiError {
  if (isErrorEnvelope(err.error)) {
    return {
      status: err.status,
      code: err.error.code,
      message: err.error.message,
      detail: err.error.detail,
    };
  }
  // Never reached the AppExceptionFilter — e.g. the connection dropped, or
  // something in front of Nest (a proxy) returned its own error page.
  return {
    status: err.status,
    code: 'NETWORK_ERROR',
    message: err.message || 'Network error',
  };
}

export const errorInterceptor: HttpInterceptorFn = (req, next) =>
  next(req).pipe(
    catchError((err: unknown) => {
      if (err instanceof HttpErrorResponse) {
        return throwError(() => toApiError(err));
      }
      throw err;
    }),
  );
