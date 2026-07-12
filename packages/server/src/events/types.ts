// Durable event and WebSocket contract types — must match CONTRACTS-v1.md exactly.
// See .octocode/rfc/lan-multi-user-collaboration/CONTRACTS-v1.md.

export const PROTOCOL_VERSION = 1 as const;

export type EventEnvelopeV1 = {
  protocolVersion: 1;
  eventId: string;
  projectId: string;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number;
  type: string;
  occurredAt: string;
};

export type WebSocketEventV1 = {
  kind: "event";
  event: EventEnvelopeV1;
};

// Page envelope — must match CONTRACTS-v1.md "Cursor pagination" exactly.
export type Page<T> = { items: T[]; nextCursor: string | null };

// Project snapshot — lastEventId is mandatory (CONTRACTS-v1.md Durable event and WebSocket contracts).
// `project` is a pass-through of whatever A1's projects table holds; A3 will extend it with
// planning/proposal/attachment state.
export type ProjectSnapshotV1 = { project: ProjectRecordV1; lastEventId: string };
export type ProjectRecordV1 = { id: string; version: number; name: string; createdAt: string };

// Standard error envelope — must match CONTRACTS-v1.md "Error envelope" exactly.
export type ApiError = {
  error: {
    code: ApiErrorCode;
    message: string;
    requestId: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
};

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

// Subscriber authorization roles — align with A3's identity contract (forward-compatible).
// A3 may extend this; A4 must accept any string and pass it through to the Authenticator.
export type SubscriberRole = "owner" | "maintainer" | "contributor" | "viewer" | string;

// Authenticator contract — pluggable so A3's session model can drop in once merged.
// Returns either a successful identity or a failure with a stable reason.
// A4 only needs: identity for upgrade auth, and identity for reauth on every push.
export type SubscriberIdentity = {
  userId: string;
  sessionId: string;
  projectId: string;
  role: SubscriberRole;
};
// Discriminated union — `ok: true` is the success discriminator, `ok: false` is failure.
export type AuthenticatorResult = { ok: true; identity: SubscriberIdentity } | { ok: false; reason: "unauthenticated" | "forbidden" };
export type Authenticator = (input: AuthenticatorInput) => Promise<AuthenticatorResult>;
export type AuthenticatorInput = {
  // For HTTP replay/snapshot APIs, headers/url carry the request.
  // For WebSocket upgrade, headers/url are the upgrade request.
  // For reauth on push, only `userId`+`projectId` are populated.
  userId?: string;
  sessionId?: string;
  projectId?: string;
  headers?: Record<string, string | string[] | undefined>;
  url?: string;
};

// Session revocation adapter — invoked by the publisher before each push to detect
// revoked or changed sessions. Returns the latest role or "unauthenticated" / "forbidden".
// A3 will implement this against its session store; for now it's pluggable.
export type SessionRevocationCheck = (input: { userId: string; sessionId: string; projectId: string }) => Promise<{ ok: true; role: SubscriberRole } | { ok: false; reason: "unauthenticated" | "forbidden" }>;

// WebSocket close codes (A4-local extension; not in CONTRACTS-v1.md).
// The 44xx range is reserved for application use by RFC 6455.
// 4401 unauthenticated, 4403 forbidden, 4408 resync_required (slow consumer or gap unresolvable).
export const WS_CLOSE_UNAUTHENTICATED = 4401;
export const WS_CLOSE_FORBIDDEN = 4403;
export const WS_CLOSE_RESYNC_REQUIRED = 4408;
export const WS_CLOSE_GOING_AWAY = 1001;

// Subscriber queue bound — when the queue exceeds this, the subscriber is closed with 4408.
export const DEFAULT_SUBSCRIBER_QUEUE_CAPACITY = 1000;

// Default event retention window — events API returns 410 event_cursor_expired if afterEventId
// is older than this. The DB row is NOT pruned; only the API treats the cursor as expired.
export const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// Poll interval for the durable-event publisher (lower bound for tests).
export const DEFAULT_PUBLISHER_POLL_INTERVAL_MS = 100;

// Heartbeat — server pings every N seconds; a client that misses 2 pongs is disconnected.
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

// Max consecutive missed pongs before disconnect.
export const DEFAULT_HEARTBEAT_MISS_LIMIT = 2;
