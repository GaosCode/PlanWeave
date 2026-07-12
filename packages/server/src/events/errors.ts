import type { ApiError, ApiErrorCode } from "./types.js";

// Error envelope helper. Per CONTRACTS-v1.md:
// - All non-2xx JSON responses use the `ApiError` envelope.
// - Status mapping is fixed (401 unauthenticated, 403 forbidden, 404 not_found,
//   409 *_conflict / idempotency_key_reused, 410 event_cursor_expired,
//   413 request_too_large, 415 unsupported_media_type, 422 validation_failed,
//   429 rate_limited, 503 service_unavailable, 500 internal_error).
export const API_ERROR_STATUS: Record<ApiErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  validation_failed: 422,
  request_too_large: 413,
  unsupported_media_type: 415,
  rate_limited: 429,
  idempotency_key_reused: 409,
  version_conflict: 409,
  state_conflict: 409,
  cursor_invalid: 400,
  event_cursor_expired: 410,
  service_unavailable: 503,
  internal_error: 500,
};

export function buildApiError(code: ApiErrorCode, message: string, requestId: string, details?: Record<string, unknown>): ApiError {
  const error: ApiError["error"] = {
    code,
    message,
    requestId,
    retryable: code === "service_unavailable" || code === "rate_limited",
  };
  if (details) error.details = details;
  return { error };
}

export function writeApiError(
  response: import("node:http").ServerResponse,
  code: ApiErrorCode,
  message: string,
  requestId: string,
  details?: Record<string, unknown>,
): void {
  const body = buildApiError(code, message, requestId, details);
  response.writeHead(API_ERROR_STATUS[code], { "content-type": "application/json; charset=utf-8", "x-request-id": requestId });
  response.end(JSON.stringify(body));
}
