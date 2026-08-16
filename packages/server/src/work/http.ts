import {
  eligibleHostBatchRequestSchema,
  assignmentListQuerySchema,
  assignmentUpdateWireCommandSchema
} from "@planweave-ai/collaboration-protocol/work/assignment";
import { executionTargetUpdateWireCommandSchema } from "@planweave-ai/collaboration-protocol/work/execution-target";
import { reviewAssignmentUpdateWireCommandSchema } from "@planweave-ai/collaboration-protocol/work/review";
import { responsibilityUpdateWireCommandSchema } from "@planweave-ai/collaboration-protocol/work/responsibility";
import { opaqueIdentifierSchema } from "@planweave-ai/agent-host-protocol";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  authenticateCollaborationForScope,
  authenticateCollaborationForProject,
  hasAuthenticatedCollaborationDevice,
  humanTransportAllowed,
  workspaceDeviceSessionHumanContext,
  type CollaborationAuthContext,
  type HumanIdentityRepository,
  type HumanProjectAuthority
} from "../identity/index.js";
import type { TransportAdmissionPolicy } from "../insecureTransport.js";
import type { WorkspaceIdentityRepository } from "../identity/workspaceRepository.js";
import { BoundedFixedWindowAdmission } from "../httpFixedWindowAdmission.js";
import type { ProjectAccessRepository } from "../projectAccessRepository.js";
import { WorkAssignmentService, WorkAssignmentServiceError } from "./service.js";
import { AuthorityService } from "./authorityService.js";
import { workItemRefSchema, type AssignmentDisplayProjection } from "./schemas.js";
import { authorityScopeSchema } from "./authoritySchemas.js";

const MAX_ASSIGNMENT_BODY_BYTES = 65_536;
const ASSIGNMENT_RATE_WINDOW_MS = 60_000;
const ASSIGNMENT_RATE_MAX_REQUESTS = 120;
const ASSIGNMENT_RATE_MAX_BUCKETS = 1_000;

type AssignmentRoute = {
  kind:
    | "get"
    | "list"
    | "update"
    | "eligible"
    | "eligible_batch"
    | "authority_get"
    | "authority_projection"
    | "responsibility"
    | "reviewer"
    | "execution_target";
  projectId: string;
  authority?: "responsibility" | "reviewer" | "execution_target";
};

const rateLimiter = new BoundedFixedWindowAdmission<string>({
  windowMs: ASSIGNMENT_RATE_WINDOW_MS,
  maxRequests: ASSIGNMENT_RATE_MAX_REQUESTS,
  maxBuckets: ASSIGNMENT_RATE_MAX_BUCKETS
});

export type WorkAssignmentHttpOptions = {
  resolveService(workspaceId: string, projectId: string): WorkAssignmentService | undefined;
  acquireAuthorityService?(
    workspaceId: string,
    projectId: string,
    canvasId: string
  ): { service: AuthorityService; release(): void } | undefined;
  repository: HumanIdentityRepository;
  workspaceIdentity: WorkspaceIdentityRepository;
  access: ProjectAccessRepository;
  projectAuthority: HumanProjectAuthority;
  transportAdmission: TransportAdmissionPolicy;
  clock?: () => Date;
};

function isWorkspaceDeviceContext(
  actor: CollaborationAuthContext
): actor is Extract<CollaborationAuthContext, { kind: "workspace_device" }> {
  return "kind" in actor && actor.kind === "workspace_device";
}

function assertAccessCapability(input: {
  actor: CollaborationAuthContext;
  workspaceId: string;
  projectId: string;
  canvasId?: string;
  capability: "assignment" | "read";
  access: ProjectAccessRepository;
}): void {
  assertPrincipalAccessCapability({
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    ...(input.canvasId === undefined ? {} : { canvasId: input.canvasId }),
    humanPrincipalId: input.actor.humanPrincipalId,
    capability: input.capability,
    access: input.access
  });
}

function assertPrincipalAccessCapability(input: {
  workspaceId: string;
  projectId: string;
  canvasId?: string;
  humanPrincipalId: string;
  capability: "assignment" | "read";
  access: ProjectAccessRepository;
}): void {
  try {
    input.access.policy.assertCapability({
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      canvasId: input.canvasId,
      actor: { kind: "human", id: input.humanPrincipalId },
      capability: input.capability
    });
  } catch {
    throw new WorkAssignmentServiceError("work_auth_forbidden");
  }
}

function hasAccessCapability(input: Parameters<typeof assertAccessCapability>[0]): boolean {
  try {
    assertAccessCapability(input);
    return true;
  } catch {
    return false;
  }
}

function hasPrincipalAccessCapability(
  input: Parameters<typeof assertPrincipalAccessCapability>[0]
): boolean {
  try {
    assertPrincipalAccessCapability(input);
    return true;
  } catch {
    return false;
  }
}

function assertTrustedScope(input: {
  projectAuthority: HumanProjectAuthority;
  workspaceId: string;
  projectId: string;
  canvasId?: string;
}): void {
  if (!input.projectAuthority.hasScope(input)) {
    throw new WorkAssignmentServiceError("work_cross_project_forbidden");
  }
}

function decodeIdentifier(value: string): string | undefined {
  try {
    return opaqueIdentifierSchema.parse(decodeURIComponent(value));
  } catch {
    return undefined;
  }
}

function route(request: IncomingMessage, pathname: string): AssignmentRoute | undefined {
  const match = /^\/api\/v1\/projects\/([^/]+)\/assignments(\/.*)?$/.exec(pathname);
  if (!match) return undefined;
  const projectId = decodeIdentifier(match[1]);
  if (!projectId) return undefined;
  const rest = match[2] ?? "";
  const authorityPaths: Record<string, AssignmentRoute["authority"]> = {
    "/responsibility": "responsibility",
    "/responsibilities": "responsibility",
    "/review-assignment": "reviewer",
    "/reviewer": "reviewer",
    "/reviewers": "reviewer",
    "/execution-target": "execution_target",
    "/execution-targets": "execution_target"
  };
  if (request.method === "GET" && (rest === "/authority" || rest === "/work-authority")) {
    return { kind: "authority_projection", projectId };
  }
  const authority = authorityPaths[rest];
  if (authority) {
    if (request.method === "POST") return { kind: authority, projectId, authority };
    if (request.method === "GET") return { kind: "authority_get", projectId, authority };
  }
  if (request.method === "GET" && rest === "") return { kind: "get", projectId };
  if (request.method === "GET" && rest === "/list") return { kind: "list", projectId };
  if (request.method === "POST" && rest === "") return { kind: "update", projectId };
  if (request.method === "GET" && rest === "/eligible-assignees") {
    return { kind: "eligible", projectId };
  }
  if (request.method === "POST" && rest === "/eligible-hosts/batch") {
    return { kind: "eligible_batch", projectId };
  }
  return undefined;
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
    "x-content-type-options": "nosniff",
    ...headers
  });
  response.end(bytes);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? "")) {
    throw new WorkAssignmentServiceError("work_input_invalid", "JSON content type required.");
  }
  const declaredLength = request.headers["content-length"];
  if (
    Array.isArray(declaredLength) ||
    (declaredLength !== undefined &&
      (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_ASSIGNMENT_BODY_BYTES))
  ) {
    throw new Error("assignment_body_too_large");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_ASSIGNMENT_BODY_BYTES) throw new Error("assignment_body_too_large");
    chunks.push(bytes);
  }
  try {
    return chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new WorkAssignmentServiceError("work_input_invalid", "Malformed JSON body.");
  }
}

function query(url: URL, allowed: readonly string[]): Record<string, string | undefined> {
  const allowedKeys = new Set(allowed);
  const result: Record<string, string | undefined> = {};
  for (const key of url.searchParams.keys()) {
    if (!allowedKeys.has(key) || url.searchParams.getAll(key).length !== 1) {
      throw new WorkAssignmentServiceError("work_input_invalid", "Invalid query parameters.");
    }
    result[key] = url.searchParams.get(key) ?? undefined;
  }
  return result;
}

function parseJsonParameter(value: string | undefined): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    throw new WorkAssignmentServiceError("work_input_invalid", "Malformed JSON query parameter.");
  }
}

function rateLimit(humanPrincipalId: string, workspaceId: string, projectId: string, now: number) {
  const key = JSON.stringify([humanPrincipalId, workspaceId, projectId]);
  return rateLimiter.admit(key, now);
}

function statusFor(error: WorkAssignmentServiceError): number {
  switch (error.code) {
    case "work_auth_unauthenticated":
      return 401;
    case "work_auth_forbidden":
    case "work_auth_project_mismatch":
    case "work_role_insufficient":
    case "work_cross_project_forbidden":
      return 403;
    case "work_item_not_found":
    case "work_host_not_found":
      return 404;
    case "work_revision_conflict":
      return 409;
    case "work_input_invalid":
    case "work_item_kind_target_mismatch":
    case "work_human_not_member":
    case "work_host_revoked":
    case "work_host_not_authorized":
    case "work_host_not_ready":
    case "work_host_capability_mismatch":
    case "work_not_agent_assigned":
    case "work_dispatch_host_mismatch":
    case "execution_target_read_only":
      return 400;
    default:
      return 400;
  }
}

function safeError(error: unknown): { status: number; code: string } {
  if (error instanceof z.ZodError) return { status: 400, code: "work_input_invalid" };
  if (error instanceof WorkAssignmentServiceError) {
    return { status: statusFor(error), code: error.code };
  }
  if (error instanceof Error && error.message === "assignment_body_too_large") {
    return { status: 413, code: "assignment_body_too_large" };
  }
  if (error instanceof Error && error.message.startsWith("authority_")) {
    const status = error.message.includes("revision_conflict")
      ? 409
      : error.message.includes("not_found")
        ? 404
        : error.message.includes("scope_forbidden") ||
            error.message.includes("project_mismatch") ||
            error.message.includes("workspace_mismatch") ||
            error.message.includes("membership_required")
          ? 403
          : 400;
    return { status, code: error.message };
  }
  return { status: 500, code: "assignment_request_failed" };
}

export function resetWorkAssignmentHttpRateLimits(): void {
  rateLimiter.reset();
}

export async function handleWorkAssignmentHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: WorkAssignmentHttpOptions
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://planweave.invalid");
  const matched = route(request, url.pathname);
  if (!matched) {
    if (/^\/api\/v1\/projects\/[^/]+\/assignments(\/|$)/.test(url.pathname)) {
      request.resume();
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
    const credentialActor = authenticateCollaborationForProject(
      options.repository,
      options.workspaceIdentity,
      request.headers.authorization,
      matched.projectId
    );
    if (
      !credentialActor &&
      !hasAuthenticatedCollaborationDevice(
        options.repository,
        options.workspaceIdentity,
        request.headers.authorization
      )
    ) {
      throw new WorkAssignmentServiceError("work_auth_unauthenticated");
    }
    const authenticated = authenticateCollaborationForScope(
      options.repository,
      options.workspaceIdentity,
      options.projectAuthority,
      request.headers.authorization,
      matched.projectId
    );
    if (!authenticated) throw new WorkAssignmentServiceError("work_cross_project_forbidden");
    const now = (options.clock ?? (() => new Date()))().getTime();
    const admission = rateLimit(
      authenticated.actor.humanPrincipalId,
      authenticated.workspaceId,
      matched.projectId,
      now
    );
    if (!admission.allowed) {
      request.resume();
      respond(
        response,
        429,
        { error: "assignment_rate_limited" },
        { "retry-after": String(admission.retryAfterSeconds) }
      );
      return true;
    }
    const actor = authenticated.actor;
    const service = options.resolveService(authenticated.workspaceId, matched.projectId);
    if (
      !service &&
      matched.kind !== "responsibility" &&
      matched.kind !== "reviewer" &&
      matched.kind !== "execution_target" &&
      matched.kind !== "authority_get" &&
      matched.kind !== "authority_projection"
    ) {
      throw new WorkAssignmentServiceError("work_cross_project_forbidden");
    }
    const serviceActor = workspaceDeviceSessionHumanContext(actor, options.workspaceIdentity);

    switch (matched.kind) {
      case "update": {
        query(url, []);
        const body = assignmentUpdateWireCommandSchema.parse(await readJson(request));
        if (!serviceActor) throw new WorkAssignmentServiceError("work_auth_forbidden");
        assertTrustedScope({
          projectAuthority: options.projectAuthority,
          workspaceId: authenticated.workspaceId,
          projectId: matched.projectId,
          canvasId: body.workItem.canvasId
        });
        assertAccessCapability({
          actor,
          workspaceId: authenticated.workspaceId,
          projectId: matched.projectId,
          canvasId: body.workItem.canvasId,
          capability: "assignment",
          access: options.access
        });
        if (body.target.kind === "exact_host" || body.target.kind === "automatic_host") {
          throw new WorkAssignmentServiceError("execution_target_read_only");
        }
        if (body.target.kind === "human") {
          assertPrincipalAccessCapability({
            workspaceId: authenticated.workspaceId,
            projectId: matched.projectId,
            canvasId: body.workItem.canvasId,
            humanPrincipalId: body.target.humanPrincipalId,
            capability: "read",
            access: options.access
          });
        }
        respond(
          response,
          200,
          service!.updateAssignment({ ...body, actor: serviceActor, projectId: matched.projectId })
            .display
        );
        return true;
      }
      case "get": {
        const parameters = query(url, ["workItem"]);
        const workItem = workItemRefSchema.parse(parseJsonParameter(parameters.workItem));
        if (!serviceActor) throw new WorkAssignmentServiceError("work_auth_forbidden");
        assertTrustedScope({
          projectAuthority: options.projectAuthority,
          workspaceId: authenticated.workspaceId,
          projectId: matched.projectId,
          canvasId: workItem.canvasId
        });
        assertAccessCapability({
          actor,
          workspaceId: authenticated.workspaceId,
          projectId: matched.projectId,
          canvasId: workItem.canvasId,
          capability: "read",
          access: options.access
        });
        respond(response, 200, service!.getAssignment(serviceActor, matched.projectId, workItem));
        return true;
      }
      case "list": {
        const parameters = query(url, ["canvasId", "workItems", "cursor", "limit"]);
        const parsed = assignmentListQuerySchema.parse({
          ...(parameters.canvasId === undefined ? {} : { canvasId: parameters.canvasId }),
          ...(parameters.workItems === undefined
            ? {}
            : { workItems: parseJsonParameter(parameters.workItems) }),
          ...(parameters.cursor === undefined ? {} : { cursor: Number(parameters.cursor) }),
          ...(parameters.limit === undefined ? {} : { limit: Number(parameters.limit) })
        });
        if (!serviceActor) throw new WorkAssignmentServiceError("work_auth_forbidden");
        if (parsed.workItems) {
          for (const canvasId of new Set(parsed.workItems.map((workItem) => workItem.canvasId))) {
            assertTrustedScope({
              projectAuthority: options.projectAuthority,
              workspaceId: authenticated.workspaceId,
              projectId: matched.projectId,
              canvasId
            });
            assertAccessCapability({
              actor,
              workspaceId: authenticated.workspaceId,
              projectId: matched.projectId,
              canvasId,
              capability: "read",
              access: options.access
            });
          }
        } else if (isWorkspaceDeviceContext(actor) && parsed.canvasId === undefined) {
          const items: AssignmentDisplayProjection[] = [];
          let cursor = parsed.cursor;
          let nextCursor: number | null = null;
          while (items.length < parsed.limit) {
            const page = service!.listAssignments(serviceActor, matched.projectId, {
              cursor,
              limit: 1
            });
            const item = page.items[0];
            if (!item) {
              nextCursor = null;
              break;
            }
            cursor += 1;
            if (
              options.projectAuthority.hasScope({
                workspaceId: authenticated.workspaceId,
                projectId: matched.projectId,
                canvasId: item.workItem.canvasId
              }) &&
              hasAccessCapability({
                actor,
                workspaceId: authenticated.workspaceId,
                projectId: matched.projectId,
                canvasId: item.workItem.canvasId,
                capability: "read",
                access: options.access
              })
            ) {
              items.push(item);
            }
            if (page.nextCursor === null) break;
            nextCursor = cursor;
          }
          respond(response, 200, { items, nextCursor });
          return true;
        } else {
          assertTrustedScope({
            projectAuthority: options.projectAuthority,
            workspaceId: authenticated.workspaceId,
            projectId: matched.projectId,
            ...(parsed.canvasId === undefined ? {} : { canvasId: parsed.canvasId })
          });
          assertAccessCapability({
            actor,
            workspaceId: authenticated.workspaceId,
            projectId: matched.projectId,
            ...(parsed.canvasId === undefined ? {} : { canvasId: parsed.canvasId }),
            capability: "read",
            access: options.access
          });
        }
        respond(response, 200, service!.listAssignments(serviceActor, matched.projectId, parsed));
        return true;
      }
      case "eligible": {
        const parameters = query(url, [
          "workItem",
          "humanLimit",
          "humanCursor",
          "hostLimit",
          "hostCursor"
        ]);
        const workItem = workItemRefSchema.parse(parseJsonParameter(parameters.workItem));
        if (!serviceActor) throw new WorkAssignmentServiceError("work_auth_forbidden");
        assertTrustedScope({
          projectAuthority: options.projectAuthority,
          workspaceId: authenticated.workspaceId,
          projectId: matched.projectId,
          canvasId: workItem.canvasId
        });
        assertAccessCapability({
          actor,
          workspaceId: authenticated.workspaceId,
          projectId: matched.projectId,
          canvasId: workItem.canvasId,
          capability: "read",
          access: options.access
        });
        const result = service!.listEligibleAssignees(serviceActor, matched.projectId, workItem, {
          ...(parameters.humanLimit === undefined
            ? {}
            : { humanLimit: Number(parameters.humanLimit) }),
          ...(parameters.humanCursor === undefined
            ? {}
            : { humanCursor: Number(parameters.humanCursor) }),
          ...(parameters.hostLimit === undefined
            ? {}
            : { hostLimit: Number(parameters.hostLimit) }),
          ...(parameters.hostCursor === undefined
            ? {}
            : { hostCursor: Number(parameters.hostCursor) })
        });
        respond(response, 200, {
          workItem: result.workItem,
          humans: result.humans.filter((human) =>
            hasPrincipalAccessCapability({
              workspaceId: authenticated.workspaceId,
              projectId: matched.projectId,
              canvasId: workItem.canvasId,
              humanPrincipalId: human.humanPrincipalId,
              capability: "read",
              access: options.access
            })
          ),
          hosts: result.hosts,
          nextHumanCursor: result.nextHumanCursor,
          nextHostCursor: result.nextHostCursor
        });
        return true;
      }
      case "eligible_batch": {
        query(url, []);
        const body = eligibleHostBatchRequestSchema.parse(await readJson(request));
        if (!serviceActor) throw new WorkAssignmentServiceError("work_auth_forbidden");
        for (const canvasId of new Set(body.workItems.map((workItem) => workItem.canvasId))) {
          assertTrustedScope({
            projectAuthority: options.projectAuthority,
            workspaceId: authenticated.workspaceId,
            projectId: matched.projectId,
            canvasId
          });
          assertAccessCapability({
            actor,
            workspaceId: authenticated.workspaceId,
            projectId: matched.projectId,
            canvasId,
            capability: "read",
            access: options.access
          });
        }
        respond(
          response,
          200,
          service!.listEligibleHostsBatch(serviceActor, matched.projectId, body)
        );
        return true;
      }
      case "responsibility": {
        query(url, []);
        const body = responsibilityUpdateWireCommandSchema.parse(await readJson(request));
        assertAccessCapability({
          actor,
          workspaceId: authenticated.workspaceId,
          projectId: matched.projectId,
          canvasId: body.scope.canvasId,
          capability: "assignment",
          access: options.access
        });
        if (
          body.scope.workspaceId !== authenticated.workspaceId ||
          body.scope.projectId !== matched.projectId
        ) {
          throw new WorkAssignmentServiceError("work_cross_project_forbidden");
        }
        if (!options.projectAuthority.hasScope({ ...authenticated, canvasId: body.scope.canvasId }))
          throw new WorkAssignmentServiceError("work_cross_project_forbidden");
        const handle = options.acquireAuthorityService?.(
          authenticated.workspaceId,
          matched.projectId,
          body.scope.canvasId
        );
        if (!handle) throw new WorkAssignmentServiceError("work_cross_project_forbidden");
        try {
          respond(response, 200, handle.service.updateResponsibility(actor, body));
        } finally {
          handle.release();
        }
        return true;
      }
      case "reviewer": {
        query(url, []);
        const body = reviewAssignmentUpdateWireCommandSchema.parse(await readJson(request));
        assertAccessCapability({
          actor,
          workspaceId: authenticated.workspaceId,
          projectId: matched.projectId,
          canvasId: body.scope.canvasId,
          capability: "assignment",
          access: options.access
        });
        if (
          body.scope.workspaceId !== authenticated.workspaceId ||
          body.scope.projectId !== matched.projectId
        ) {
          throw new WorkAssignmentServiceError("work_cross_project_forbidden");
        }
        if (!options.projectAuthority.hasScope({ ...authenticated, canvasId: body.scope.canvasId }))
          throw new WorkAssignmentServiceError("work_cross_project_forbidden");
        const handle = options.acquireAuthorityService?.(
          authenticated.workspaceId,
          matched.projectId,
          body.scope.canvasId
        );
        if (!handle) throw new WorkAssignmentServiceError("work_cross_project_forbidden");
        try {
          respond(response, 200, handle.service.updateReviewer(actor, body));
        } finally {
          handle.release();
        }
        return true;
      }
      case "execution_target": {
        query(url, []);
        const body = executionTargetUpdateWireCommandSchema.parse(await readJson(request));
        assertAccessCapability({
          actor,
          workspaceId: authenticated.workspaceId,
          projectId: matched.projectId,
          canvasId: body.scope.canvasId,
          capability: "assignment",
          access: options.access
        });
        if (
          body.scope.workspaceId !== authenticated.workspaceId ||
          body.scope.projectId !== matched.projectId
        ) {
          throw new WorkAssignmentServiceError("work_cross_project_forbidden");
        }
        if (!options.projectAuthority.hasScope({ ...authenticated, canvasId: body.scope.canvasId }))
          throw new WorkAssignmentServiceError("work_cross_project_forbidden");
        throw new WorkAssignmentServiceError("execution_target_read_only");
      }
      case "authority_get": {
        const parameters = query(url, ["scope"]);
        const scope = authorityScopeSchema.parse(parseJsonParameter(parameters.scope));
        if (!options.projectAuthority.hasScope({ ...authenticated, canvasId: scope.canvasId }))
          throw new WorkAssignmentServiceError("work_cross_project_forbidden");
        const handle = options.acquireAuthorityService?.(
          authenticated.workspaceId,
          matched.projectId,
          scope.canvasId
        );
        if (!handle) throw new WorkAssignmentServiceError("work_cross_project_forbidden");
        try {
          const result =
            matched.authority === "responsibility"
              ? handle.service.getResponsibility(actor, scope)
              : matched.authority === "reviewer"
                ? handle.service.getReviewer(actor, scope)
                : handle.service.getExecutionTarget(actor, scope);
          respond(response, 200, result ?? null);
        } finally {
          handle.release();
        }
        return true;
      }
      case "authority_projection": {
        const parameters = query(url, ["scope"]);
        const scope = authorityScopeSchema.parse(parseJsonParameter(parameters.scope));
        if (!options.projectAuthority.hasScope({ ...authenticated, canvasId: scope.canvasId }))
          throw new WorkAssignmentServiceError("work_cross_project_forbidden");
        const handle = options.acquireAuthorityService?.(
          authenticated.workspaceId,
          matched.projectId,
          scope.canvasId
        );
        if (!handle) throw new WorkAssignmentServiceError("work_cross_project_forbidden");
        try {
          respond(response, 200, handle.service.getWorkAuthorityProjection(actor, scope));
        } finally {
          handle.release();
        }
        return true;
      }
    }
  } catch (error) {
    const safe = safeError(error);
    request.resume();
    respond(response, safe.status, { error: safe.code });
    return true;
  }
}
