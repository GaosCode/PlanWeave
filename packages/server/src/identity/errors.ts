export type ApiErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "validation_failed"
  | "request_too_large"
  | "unsupported_media_type"
  | "rate_limited"
  | "idempotency_key_reused"
  | "version_conflict"
  | "state_conflict"
  | "cursor_invalid"
  | "event_cursor_expired"
  | "service_unavailable"
  | "internal_error";

export class DomainError extends Error {
  readonly code: ApiErrorCode;
  readonly details: Record<string, unknown>;
  constructor(code: ApiErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.details = details;
    this.name = "DomainError";
  }
}

export function notFound(entity: string, id: string): DomainError {
  return new DomainError("not_found", `${entity} not found`, { entity, id });
}

export function forbidden(message: string, details: Record<string, unknown> = {}): DomainError {
  return new DomainError("forbidden", message, details);
}

export function validationFailed(message: string, details: Record<string, unknown> = {}): DomainError {
  return new DomainError("validation_failed", message, details);
}

export function stateConflict(message: string, details: Record<string, unknown> = {}): DomainError {
  return new DomainError("state_conflict", message, details);
}

export function versionConflict(aggregateType: string, aggregateId: string, currentVersion: number, expectedVersion: number): DomainError {
  return new DomainError("version_conflict", `Stale expected version ${expectedVersion} for ${aggregateType}:${aggregateId}`, { aggregateType, aggregateId, currentVersion, expectedVersion });
}

export function requestTooLarge(message: string, details: Record<string, unknown> = {}): DomainError {
  return new DomainError("request_too_large", message, details);
}

export function unauthenticated(message: string = "Authentication required"): DomainError {
  return new DomainError("unauthenticated", message);
}
