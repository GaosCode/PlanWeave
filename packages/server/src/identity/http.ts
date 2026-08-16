import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import {
  humanCreateInvitationRequestSchema,
  type HumanCreateInvitationRequest
} from "@planweave-ai/collaboration-protocol/identity/workspace";
import { opaqueIdentifierSchema } from "@planweave-ai/agent-host-protocol";
import { z } from "zod";
import {
  humanNetworkTransportAllowed,
  localAdminBootstrapAllowed,
  type TransportAdmissionPolicy
} from "../insecureTransport.js";
import { BoundedFixedWindowAdmission } from "../httpFixedWindowAdmission.js";
import { authenticateHumanForProject } from "./auth.js";
import {
  HUMAN_AUTH_ERROR_MESSAGES,
  humanAuthErrorCodeSchema,
  type HumanAuthErrorCode
} from "./errors.js";
import { HumanIdentityRepository } from "./repository.js";
import {
  HumanMembershipService,
  HumanMembershipServiceError,
  type HumanProjectAuthority
} from "./service.js";
import {
  HUMAN_DEVICE_TOKEN_PREFIX,
  HUMAN_TOKEN_SECRET_CHAR_LENGTH,
  PROJECT_INVITATION_IDEMPOTENCY_CACHE_MAX_ENTRIES,
  PROJECT_INVITATION_IDEMPOTENCY_CACHE_TTL_MS,
  PROJECT_INVITATION_TOKEN_PREFIX
} from "./limits.js";
import { humanConsumeInvitationRequestSchema } from "./dtos.js";

const MAX_HUMAN_BODY_BYTES = 16_384;
/** Soft admission limit for human auth-sensitive routes (per authenticated credential subject). */
const HUMAN_RATE_WINDOW_MS = 60_000;
const HUMAN_RATE_MAX_REQUESTS = 60;
/** Bounds untrusted remote-address/project tuples retained by each in-process limit class. */
export const HUMAN_RATE_MAX_BUCKETS = 1_000;

export type HumanHttpOptions = {
  service: HumanMembershipService;
  repository: HumanIdentityRepository;
  projectAuthority: HumanProjectAuthority;
  transportAdmission: TransportAdmissionPolicy;
  clock?: () => Date;
};

type HumanRoute =
  | { kind: "bootstrap"; projectId: string }
  | { kind: "consume_invitation"; projectId: string }
  | { kind: "create_invitation"; projectId: string }
  | { kind: "list_invitations"; projectId: string }
  | { kind: "revoke_invitations"; projectId: string }
  | { kind: "revoke_invitation"; projectId: string; invitationId: string }
  | { kind: "list_members"; projectId: string }
  | { kind: "update_own_profile"; projectId: string }
  | { kind: "remove_member"; projectId: string; humanPrincipalId: string }
  | { kind: "promote_owner"; projectId: string; humanPrincipalId: string }
  | { kind: "demote_owner"; projectId: string; humanPrincipalId: string }
  | { kind: "list_devices"; projectId: string }
  | { kind: "revoke_device"; projectId: string; deviceCredentialId: string };

type HumanRateClass = "read" | "sensitive_write";
const rateLimiters: Record<HumanRateClass, BoundedFixedWindowAdmission<string>> = {
  read: new BoundedFixedWindowAdmission({
    windowMs: HUMAN_RATE_WINDOW_MS,
    maxRequests: HUMAN_RATE_MAX_REQUESTS,
    maxBuckets: HUMAN_RATE_MAX_BUCKETS
  }),
  sensitive_write: new BoundedFixedWindowAdmission({
    windowMs: HUMAN_RATE_WINDOW_MS,
    maxRequests: HUMAN_RATE_MAX_REQUESTS,
    maxBuckets: HUMAN_RATE_MAX_BUCKETS
  })
};

type InvitationCreateResult = ReturnType<HumanMembershipService["createInvitation"]>;
type InvitationIdempotencyEntry = {
  promise: Promise<InvitationCreateResult>;
  /** Pending entries have no expiry and are always shared until they settle. */
  expiresAt?: number;
  expiryTimer?: ReturnType<typeof setTimeout>;
};
const invitationIdempotencyEntries = new Map<string, InvitationIdempotencyEntry>();
const invitationRepositoryScopeIds = new WeakMap<HumanIdentityRepository, number>();
let nextInvitationRepositoryScopeId = 1;

class HumanRateLimitError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("human_rate_limited");
  }
}

function decodeIdentifier(value: string): string | undefined {
  try {
    return opaqueIdentifierSchema.parse(decodeURIComponent(value));
  } catch {
    return undefined;
  }
}

function route(request: IncomingMessage, pathname: string): HumanRoute | undefined {
  const projectMatch = /^\/api\/v1\/projects\/([^/]+)\/human(\/.*)?$/.exec(pathname);
  if (!projectMatch) return undefined;
  const projectId = decodeIdentifier(projectMatch[1]);
  if (!projectId) return undefined;
  const rest = projectMatch[2] ?? "";

  if (request.method === "POST" && rest === "/bootstrap") {
    return { kind: "bootstrap", projectId };
  }
  if (request.method === "POST" && rest === "/invitations/consume") {
    return { kind: "consume_invitation", projectId };
  }
  if (request.method === "POST" && rest === "/invitations") {
    return { kind: "create_invitation", projectId };
  }
  if (request.method === "GET" && rest === "/invitations") {
    return { kind: "list_invitations", projectId };
  }
  if (request.method === "POST" && rest === "/invitations/revoke-batch") {
    return { kind: "revoke_invitations", projectId };
  }
  const revokeInvitation = /^\/invitations\/([^/]+)\/revoke$/.exec(rest);
  if (request.method === "POST" && revokeInvitation) {
    const invitationId = decodeIdentifier(revokeInvitation[1]);
    if (!invitationId) return undefined;
    return { kind: "revoke_invitation", projectId, invitationId };
  }
  if (request.method === "GET" && rest === "/members") {
    return { kind: "list_members", projectId };
  }
  if (request.method === "PATCH" && rest === "/me") {
    return { kind: "update_own_profile", projectId };
  }
  const memberAction = /^\/members\/([^/]+)\/(remove|promote|demote)$/.exec(rest);
  if (request.method === "POST" && memberAction) {
    const humanPrincipalId = decodeIdentifier(memberAction[1]);
    if (!humanPrincipalId) return undefined;
    if (memberAction[2] === "remove") {
      return { kind: "remove_member", projectId, humanPrincipalId };
    }
    if (memberAction[2] === "promote") {
      return { kind: "promote_owner", projectId, humanPrincipalId };
    }
    return { kind: "demote_owner", projectId, humanPrincipalId };
  }
  if (request.method === "GET" && rest === "/devices") {
    return { kind: "list_devices", projectId };
  }
  const revokeDevice = /^\/devices\/([^/]+)\/revoke$/.exec(rest);
  if (request.method === "POST" && revokeDevice) {
    const deviceCredentialId = decodeIdentifier(revokeDevice[1]);
    if (!deviceCredentialId) return undefined;
    return { kind: "revoke_device", projectId, deviceCredentialId };
  }
  return undefined;
}

function isHumanApiCandidate(pathname: string): boolean {
  return pathname.startsWith("/api/v1/projects/") && pathname.includes("/human");
}

function respond(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {}
): void {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": bytes.byteLength,
    "cache-control": "no-store",
    ...headers
  });
  response.end(bytes);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? "")) {
    throw new HumanMembershipServiceError("human_input_invalid", "JSON content type required.");
  }
  const declaredLength = request.headers["content-length"];
  if (Array.isArray(declaredLength)) {
    throw new HumanMembershipServiceError("human_input_invalid", "Invalid content length.");
  }
  if (
    declaredLength &&
    (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_HUMAN_BODY_BYTES)
  ) {
    const error = new Error("human_body_too_large");
    throw error;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_HUMAN_BODY_BYTES) throw new Error("human_body_too_large");
    chunks.push(bytes);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HumanMembershipServiceError("human_input_invalid", "Malformed JSON body.");
  }
}

function query(url: URL, allowed: readonly string[]): Record<string, string | undefined> {
  const allowedKeys = new Set(allowed);
  const result: Record<string, string | undefined> = {};
  for (const key of url.searchParams.keys()) {
    if (!allowedKeys.has(key) || url.searchParams.getAll(key).length !== 1) {
      throw new HumanMembershipServiceError("human_input_invalid", "Invalid query parameters.");
    }
    result[key] = url.searchParams.get(key) ?? undefined;
  }
  return result;
}

export function humanTransportAllowed(
  socket: { encrypted?: boolean; remoteAddress?: string },
  transportAdmission: TransportAdmissionPolicy
): boolean {
  return humanNetworkTransportAllowed(socket, transportAdmission);
}

/**
 * Local administrative boundary for owner bootstrap: only loopback clients may mint the
 * first project owner. This is not a network bearer and not Host/operator auth.
 */
export function humanLocalAdminBoundaryAllowed(
  socket: { remoteAddress?: string },
  admission: TransportAdmissionPolicy
): boolean {
  return localAdminBootstrapAllowed(socket, admission);
}

function rateClass(route: HumanRoute): HumanRateClass {
  switch (route.kind) {
    case "list_invitations":
    case "list_members":
    case "list_devices":
      return "read";
    default:
      return "sensitive_write";
  }
}

function rateLimitKey(
  subject: string,
  projectId: string,
  rateClass: HumanRateClass,
  routeKind: HumanRoute["kind"]
): string {
  return JSON.stringify([subject, projectId, rateClass, rateClass === "read" ? routeKind : "all"]);
}

function checkRateLimit(subject: string, projectId: string, route: HumanRoute, now: number) {
  const requestClass = rateClass(route);
  const key = rateLimitKey(subject, projectId, requestClass, route.kind);
  return rateLimiters[requestClass].admit(key, now);
}

function credentialRateLimitSubject(kind: "invitation", credential: string): string {
  return `${kind}:${createHash("sha256").update(credential).digest("hex")}`;
}

function enforceRateLimit(
  subject: string,
  projectId: string,
  route: HumanRoute,
  now: number
): void {
  const result = checkRateLimit(subject, projectId, route, now);
  if (!result.allowed) throw new HumanRateLimitError(result.retryAfterSeconds);
}

/** Test helper to clear in-memory admission and invitation replay state. */
export function resetHumanHttpRateLimits(): void {
  rateLimiters.read.reset();
  rateLimiters.sensitive_write.reset();
  for (const entry of invitationIdempotencyEntries.values()) {
    if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
  }
  invitationIdempotencyEntries.clear();
}

function httpStatusForCode(code: HumanAuthErrorCode): number {
  switch (code) {
    case "human_auth_unauthenticated":
      return 401;
    case "human_auth_forbidden":
    case "human_auth_project_mismatch":
    case "human_membership_required":
    case "human_role_insufficient":
    case "human_last_owner_protected":
    case "human_self_target_forbidden":
    case "human_bootstrap_requires_local_admin":
    case "human_invitation_invalid":
    case "human_invitation_expired":
    case "human_invitation_revoked":
    case "human_invitation_consumed":
    case "human_invitation_role_forbidden":
    case "human_device_revoked":
    case "human_device_expired":
    case "human_device_not_owner":
    case "human_credential_kind_mismatch":
    case "human_cross_project_forbidden":
    case "human_identity_workspace_mismatch":
      return 403;
    case "human_bootstrap_conflict":
    case "human_limit_exceeded":
      return 409;
    case "human_input_invalid":
      return 400;
    default: {
      const _exhaustive: never = code;
      return 500;
    }
  }
}

function safeError(error: unknown): { status: number; code: string; retryAfterSeconds?: number } {
  if (error instanceof z.ZodError) {
    return { status: 400, code: "human_input_invalid" };
  }
  if (error instanceof HumanMembershipServiceError) {
    const code = humanAuthErrorCodeSchema.parse(error.code);
    return { status: httpStatusForCode(code), code };
  }
  if (error instanceof HumanRateLimitError) {
    return {
      status: 429,
      code: "human_rate_limited",
      retryAfterSeconds: error.retryAfterSeconds
    };
  }
  if (error instanceof Error) {
    if (error.message === "human_body_too_large") {
      return { status: 413, code: "human_body_too_large" };
    }
  }
  return { status: 500, code: "human_request_failed" };
}

function invitationIdempotencyCacheKey(input: {
  repository: HumanIdentityRepository;
  projectId: string;
  humanPrincipalId: string;
  idempotencyKey: string;
}): string {
  let repositoryScopeId = invitationRepositoryScopeIds.get(input.repository);
  if (repositoryScopeId === undefined) {
    repositoryScopeId = nextInvitationRepositoryScopeId;
    nextInvitationRepositoryScopeId += 1;
    invitationRepositoryScopeIds.set(input.repository, repositoryScopeId);
  }
  return JSON.stringify([
    repositoryScopeId,
    input.projectId,
    input.humanPrincipalId,
    input.idempotencyKey
  ]);
}

function pruneInvitationIdempotencyEntries(now: number): void {
  for (const [key, entry] of invitationIdempotencyEntries) {
    if (entry.expiresAt !== undefined && entry.expiresAt <= now) {
      if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
      invitationIdempotencyEntries.delete(key);
    }
  }
}

async function createInvitationIdempotently(input: {
  options: HumanHttpOptions;
  context: ReturnType<typeof requireHumanContext>;
  projectId: string;
  body: HumanCreateInvitationRequest;
  now: number;
}): Promise<InvitationCreateResult> {
  const idempotencyKey = input.body.idempotencyKey;
  if (idempotencyKey === undefined) {
    return input.options.service.createInvitation(input.context, input.projectId, {
      ttlMs: input.body.ttlMs
    });
  }

  pruneInvitationIdempotencyEntries(input.now);
  const cacheKey = invitationIdempotencyCacheKey({
    repository: input.options.repository,
    projectId: input.projectId,
    humanPrincipalId: input.context.humanPrincipalId,
    idempotencyKey
  });
  const existing = invitationIdempotencyEntries.get(cacheKey);
  if (existing) return existing.promise;

  if (invitationIdempotencyEntries.size >= PROJECT_INVITATION_IDEMPOTENCY_CACHE_MAX_ENTRIES) {
    const earliestExpiry = Math.min(
      ...Array.from(
        invitationIdempotencyEntries.values(),
        (entry) => entry.expiresAt ?? input.now + PROJECT_INVITATION_IDEMPOTENCY_CACHE_TTL_MS
      )
    );
    throw new HumanRateLimitError(Math.max(1, Math.ceil((earliestExpiry - input.now) / 1_000)));
  }

  const entry: InvitationIdempotencyEntry = {
    promise: Promise.resolve().then(() =>
      input.options.service.createInvitation(input.context, input.projectId, {
        ttlMs: input.body.ttlMs
      })
    )
  };
  invitationIdempotencyEntries.set(cacheKey, entry);
  try {
    const result = await entry.promise;
    entry.expiresAt = input.now + PROJECT_INVITATION_IDEMPOTENCY_CACHE_TTL_MS;
    entry.expiryTimer = setTimeout(() => {
      if (invitationIdempotencyEntries.get(cacheKey) === entry) {
        invitationIdempotencyEntries.delete(cacheKey);
      }
    }, PROJECT_INVITATION_IDEMPOTENCY_CACHE_TTL_MS);
    entry.expiryTimer.unref();
    return result;
  } catch (error) {
    if (invitationIdempotencyEntries.get(cacheKey) === entry) {
      invitationIdempotencyEntries.delete(cacheKey);
    }
    throw error;
  }
}

/**
 * Redact secrets from accidental error surfaces. Public error bodies only use stable codes.
 */
function publicErrorBody(code: string): { error: string } {
  // Never echo token-shaped strings.
  if (
    code.includes(HUMAN_DEVICE_TOKEN_PREFIX) ||
    code.includes(PROJECT_INVITATION_TOKEN_PREFIX) ||
    code.length > HUMAN_TOKEN_SECRET_CHAR_LENGTH + 16
  ) {
    return { error: "human_request_failed" };
  }
  return { error: code };
}

function requireHumanContext(
  options: HumanHttpOptions,
  request: IncomingMessage,
  projectId: string
) {
  const context = authenticateHumanForProject(
    options.repository,
    request.headers.authorization,
    projectId
  );
  if (!context) {
    throw new HumanMembershipServiceError("human_auth_unauthenticated");
  }
  return context;
}

export async function handleHumanHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: HumanHttpOptions
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://planweave.invalid");
  const matched = route(request, url.pathname);
  if (!matched) {
    if (isHumanApiCandidate(url.pathname)) {
      respond(response, 404, { error: "route_not_found" });
      return true;
    }
    return false;
  }

  try {
    if (!humanTransportAllowed(request.socket, options.transportAdmission)) {
      request.resume();
      respond(response, 426, { error: "human_insecure_transport" });
      return true;
    }

    if (!options.projectAuthority.hasProject(matched.projectId)) {
      request.resume();
      respond(response, 403, { error: "human_cross_project_forbidden" });
      return true;
    }

    const now = (options.clock ?? (() => new Date()))().getTime();
    if (matched.kind === "bootstrap") {
      enforceRateLimit(
        `local-admin:${request.socket.remoteAddress ?? "unknown"}`,
        matched.projectId,
        matched,
        now
      );
    } else if (matched.kind !== "consume_invitation") {
      const context = requireHumanContext(options, request, matched.projectId);
      enforceRateLimit(`human:${context.humanPrincipalId}`, matched.projectId, matched, now);
    }

    switch (matched.kind) {
      case "bootstrap": {
        if (!humanLocalAdminBoundaryAllowed(request.socket, options.transportAdmission)) {
          request.resume();
          respond(response, 403, {
            error: "human_bootstrap_requires_local_admin",
            message: HUMAN_AUTH_ERROR_MESSAGES.human_bootstrap_requires_local_admin
          });
          return true;
        }
        query(url, []);
        const body = await readJson(request);
        const result = options.service.bootstrapOwner(matched.projectId, body);
        respond(response, result.created ? 201 : 200, result);
        break;
      }
      case "consume_invitation": {
        query(url, []);
        const body = humanConsumeInvitationRequestSchema.parse(await readJson(request));
        enforceRateLimit(
          credentialRateLimitSubject("invitation", body.invitationToken),
          matched.projectId,
          matched,
          now
        );
        const result = options.service.consumeInvitation(matched.projectId, body);
        respond(response, 201, result);
        break;
      }
      case "create_invitation": {
        query(url, []);
        const context = requireHumanContext(options, request, matched.projectId);
        const body = humanCreateInvitationRequestSchema.parse(await readJson(request));
        const result = await createInvitationIdempotently({
          options,
          context,
          projectId: matched.projectId,
          body,
          now
        });
        respond(response, 201, result);
        break;
      }
      case "list_invitations": {
        const context = requireHumanContext(options, request, matched.projectId);
        const parameters = query(url, ["cursor", "limit", "openOnly"]);
        respond(
          response,
          200,
          options.service.listInvitations(context, matched.projectId, parameters)
        );
        break;
      }
      case "revoke_invitation": {
        query(url, []);
        const context = requireHumanContext(options, request, matched.projectId);
        request.resume();
        respond(
          response,
          200,
          options.service.revokeInvitation(context, matched.projectId, matched.invitationId)
        );
        break;
      }
      case "revoke_invitations": {
        query(url, []);
        const context = requireHumanContext(options, request, matched.projectId);
        const body = await readJson(request);
        respond(response, 200, options.service.revokeInvitations(context, matched.projectId, body));
        break;
      }
      case "list_members": {
        const context = requireHumanContext(options, request, matched.projectId);
        const parameters = query(url, ["cursor", "limit"]);
        respond(response, 200, options.service.listMembers(context, matched.projectId, parameters));
        break;
      }
      case "update_own_profile": {
        query(url, []);
        const context = requireHumanContext(options, request, matched.projectId);
        const body = await readJson(request);
        respond(
          response,
          200,
          options.service.updateOwnDisplayName(context, matched.projectId, body)
        );
        break;
      }
      case "remove_member": {
        query(url, []);
        const context = requireHumanContext(options, request, matched.projectId);
        request.resume();
        respond(
          response,
          200,
          options.service.removeMember(context, matched.projectId, matched.humanPrincipalId)
        );
        break;
      }
      case "promote_owner": {
        query(url, []);
        const context = requireHumanContext(options, request, matched.projectId);
        request.resume();
        respond(
          response,
          200,
          options.service.promoteOwner(context, matched.projectId, matched.humanPrincipalId)
        );
        break;
      }
      case "demote_owner": {
        query(url, []);
        const context = requireHumanContext(options, request, matched.projectId);
        request.resume();
        respond(
          response,
          200,
          options.service.demoteOwner(context, matched.projectId, matched.humanPrincipalId)
        );
        break;
      }
      case "list_devices": {
        const context = requireHumanContext(options, request, matched.projectId);
        const parameters = query(url, ["cursor", "limit", "scope"]);
        respond(response, 200, options.service.listDevices(context, matched.projectId, parameters));
        break;
      }
      case "revoke_device": {
        query(url, []);
        const context = requireHumanContext(options, request, matched.projectId);
        request.resume();
        respond(
          response,
          200,
          options.service.revokeDevice(context, matched.projectId, matched.deviceCredentialId)
        );
        break;
      }
      default: {
        const _exhaustive: never = matched;
        respond(response, 404, { error: "route_not_found" });
      }
    }
  } catch (error) {
    const safe = safeError(error);
    request.resume();
    if (!response.headersSent) {
      respond(
        response,
        safe.status,
        publicErrorBody(safe.code),
        safe.retryAfterSeconds === undefined
          ? {}
          : { "retry-after": String(safe.retryAfterSeconds) }
      );
    } else response.destroy();
  }
  return true;
}
