import type { IncomingMessage, ServerResponse } from "node:http";
import {
  actorRefSchema,
  type ActorRef
} from "@planweave-ai/collaboration-protocol/core/primitives";
import {
  canvasAccessPageSchema,
  canvasAccessRecordSchema,
  canvasAccessRequestSchema,
  projectAccessPageSchema,
  projectAccessRequestSchema,
  registryPageQuerySchema,
  type CanvasAccessPage,
  type CanvasAccessRecord,
  type ProjectAccessPage
} from "@planweave-ai/collaboration-protocol/access/project";
import {
  createPackageSnapshotRequestSchema,
  createPackageSnapshotResultSchema,
  packageSnapshotSchema,
  restorePackageSnapshotRequestSchema,
  restorePackageSnapshotResultSchema,
  type CreatePackageSnapshotResult,
  type PackageSnapshot,
  type RestorePackageSnapshotResult
} from "@planweave-ai/collaboration-protocol/content/snapshot";
import { opaqueIdentifierSchema } from "@planweave-ai/agent-host-protocol";
import { z } from "zod";
import {
  parseHumanDeviceBearer,
  humanTransportAllowed,
  type HumanIdentityRepository
} from "./identity/index.js";
import type { TransportAdmissionPolicy } from "./insecureTransport.js";
import { WorkspaceIdentityRepository } from "./identity/workspaceRepository.js";
import type { ServerReadiness } from "./readiness.js";

const MAX_REGISTRY_BODY_BYTES = 16 * 1024;

export type RegistryListInput = {
  workspaceId: string;
  actor: ActorRef;
  cursor: number;
  limit: number;
};

export type RegistryCanvasInput = RegistryListInput & { projectId: string };
export type RegistryCanvasRegistrationInput = {
  workspaceId: string;
  actor: ActorRef;
  projectId: string;
  canvasId: string;
};

export type RegistrySnapshotInput = {
  workspaceId: string;
  actor: ActorRef;
  projectId: string;
  canvasId: string;
  snapshotId: string;
};

export type RegistrySnapshotMutationInput = RegistrySnapshotInput & {
  expectedAclRevision: number;
};

/** Narrow server-owned seam; repository and path-bearing runtime objects stay private. */
export type RegistryHttpService = {
  listProjects(input: RegistryListInput): ProjectAccessPage;
  listCanvases(input: RegistryCanvasInput): CanvasAccessPage;
  registerCanvas(input: RegistryCanvasRegistrationInput): CanvasAccessRecord;
  readSnapshot(input: RegistrySnapshotInput): PackageSnapshot;
  createSnapshot(
    input: Omit<RegistrySnapshotMutationInput, "snapshotId">
  ): Promise<CreatePackageSnapshotResult>;
  restoreSnapshot(input: RegistrySnapshotMutationInput): Promise<RestorePackageSnapshotResult>;
};

export type RegistryHttpOptions = {
  repository: HumanIdentityRepository;
  workspaceIdentity: WorkspaceIdentityRepository;
  service: RegistryHttpService;
  readiness?: () => ServerReadiness;
  transportAdmission: TransportAdmissionPolicy;
};

type RegistryRoute =
  | { kind: "projects" }
  | { kind: "canvases"; projectId: string }
  | { kind: "register_canvas"; projectId: string }
  | { kind: "create_snapshot"; projectId: string; canvasId: string }
  | { kind: "read_snapshot"; projectId: string; canvasId: string; snapshotId: string }
  | { kind: "restore_snapshot"; projectId: string; canvasId: string; snapshotId: string };

function decodeIdentifier(value: string): string | undefined {
  try {
    return opaqueIdentifierSchema.parse(decodeURIComponent(value));
  } catch {
    return undefined;
  }
}

function route(request: IncomingMessage, pathname: string): RegistryRoute | undefined {
  if (request.method === "GET" && pathname === "/api/v1/registry/projects") {
    return { kind: "projects" };
  }
  const match =
    /^\/api\/v1\/registry\/projects\/([^/]+)\/canvases(?:\/([^/]+)\/snapshots(?:\/([^/]+)(\/restore)?)?)?$/.exec(
      pathname
    );
  if (!match) return undefined;
  const projectId = decodeIdentifier(match[1]);
  if (!projectId) return undefined;
  if (!match[2]) {
    if (request.method === "GET") return { kind: "canvases", projectId };
    if (request.method === "POST") return { kind: "register_canvas", projectId };
    return undefined;
  }
  const canvasId = decodeIdentifier(match[2]);
  if (!canvasId) return undefined;
  if (!match[3]) {
    if (request.method !== "POST") return undefined;
    return { kind: "create_snapshot", projectId, canvasId };
  }
  const snapshotId = decodeIdentifier(match[3]);
  if (!snapshotId) return undefined;
  if (match[4] === "/restore") {
    if (request.method !== "POST") return undefined;
    return { kind: "restore_snapshot", projectId, canvasId, snapshotId };
  }
  if (request.method !== "GET") return undefined;
  return { kind: "read_snapshot", projectId, canvasId, snapshotId };
}

function isRegistryCandidate(pathname: string): boolean {
  return pathname === "/api/v1/registry" || pathname.startsWith("/api/v1/registry/");
}

function respond(response: ServerResponse, status: number, body: unknown): void {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": bytes.byteLength,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(bytes);
}

function query(url: URL, allowed: readonly string[]): Record<string, string | undefined> {
  const keys = new Set(allowed);
  const result: Record<string, string | undefined> = {};
  for (const key of url.searchParams.keys()) {
    if (!keys.has(key) || url.searchParams.getAll(key).length !== 1) {
      throw new Error("registry_query_invalid");
    }
    result[key] = url.searchParams.get(key) ?? undefined;
  }
  return result;
}

function pageQuery(url: URL) {
  const raw = query(url, ["cursor", "limit"]);
  const numberValue = (value: string | undefined): number | undefined => {
    if (value === undefined) return undefined;
    if (!/^\d+$/.test(value)) throw new Error("registry_query_invalid");
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) throw new Error("registry_query_invalid");
    return parsed;
  };
  const cursor = numberValue(raw.cursor);
  const limit = numberValue(raw.limit);
  return registryPageQuerySchema.parse({
    ...(cursor === undefined ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit })
  });
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? "")) {
    throw new Error("registry_content_type_invalid");
  }
  const declaredLength = request.headers["content-length"];
  if (
    Array.isArray(declaredLength) ||
    (declaredLength !== undefined &&
      (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_REGISTRY_BODY_BYTES))
  ) {
    throw new Error("registry_body_too_large");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_REGISTRY_BODY_BYTES) throw new Error("registry_body_too_large");
    chunks.push(bytes);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("registry_json_invalid");
  }
}

function safeError(error: unknown): { status: number; code: string } {
  if (error instanceof z.ZodError) return { status: 400, code: "registry_request_invalid" };
  if (error instanceof Error) {
    if (error.message === "registry_body_too_large") return { status: 413, code: error.message };
    if (
      error.message === "registry_content_type_invalid" ||
      error.message === "registry_json_invalid" ||
      error.message === "registry_query_invalid"
    ) {
      return { status: 400, code: "registry_request_invalid" };
    }
    if (error.message === "registry_workspace_scope_forbidden") {
      return { status: 403, code: error.message };
    }
    if (error.message.startsWith("access_capability_denied:")) {
      return { status: 403, code: "registry_access_denied" };
    }
    if (error.message === "registry_unauthorized") {
      return { status: 401, code: error.message };
    }
    if (error.message === "snapshot_stale_acl_revision") {
      return { status: 409, code: error.message };
    }
    if (error.message.includes("registry_conflict") || error.message.includes("registry_revoked")) {
      return { status: 409, code: error.message };
    }
    if (error.message === "canvas_runtime_unavailable") {
      return { status: 503, code: error.message };
    }
    if (error.message.includes("access_denied") || error.message.includes("not_found")) {
      return { status: 404, code: "registry_resource_not_found" };
    }
  }
  return { status: 500, code: "registry_request_failed" };
}

function actorForRequest(
  options: RegistryHttpOptions,
  request: IncomingMessage
): {
  workspaceId: string;
  actor: ActorRef;
} {
  const token = parseHumanDeviceBearer(request.headers.authorization);
  if (!token) throw new Error("registry_unauthorized");
  const workspaceSession = options.workspaceIdentity.authenticateWorkspaceDeviceSession(token);
  const authenticated = options.repository.authenticateDevice(token);
  if (!workspaceSession && !authenticated) throw new Error("registry_unauthorized");
  if (workspaceSession && authenticated) {
    const legacyWorkspace = options.workspaceIdentity.workspaceForLegacyProject(
      authenticated.device.mintedForProjectId
    );
    if (
      legacyWorkspace !== workspaceSession.workspaceId ||
      authenticated.principal.humanPrincipalId !== workspaceSession.humanPrincipalId
    ) {
      throw new Error("registry_workspace_scope_forbidden");
    }
  }
  const humanPrincipalId =
    workspaceSession?.humanPrincipalId ?? authenticated!.principal.humanPrincipalId;
  const displayName = workspaceSession?.displayName ?? authenticated!.principal.displayName;
  const workspaceIds = workspaceSession
    ? [workspaceSession.workspaceId]
    : options.workspaceIdentity.activeWorkspaceIdsForHumanPrincipal(humanPrincipalId);
  if (workspaceIds.length !== 1) throw new Error("registry_workspace_scope_forbidden");
  return {
    workspaceId: workspaceIds[0],
    actor: actorRefSchema.parse({
      kind: "human",
      id: humanPrincipalId,
      displayName
    })
  };
}

function assertRouteBodyScope(
  body: { projectId: string; canvasId: string },
  routeValue: { projectId: string; canvasId: string }
): void {
  if (body.projectId !== routeValue.projectId || body.canvasId !== routeValue.canvasId) {
    throw new Error("registry_scope_mismatch");
  }
}

export async function handleRegistryHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: RegistryHttpOptions
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://planweave.invalid");
  const matched = route(request, url.pathname);
  if (!matched) {
    if (isRegistryCandidate(url.pathname)) {
      request.resume();
      respond(response, 404, { error: "registry_resource_not_found" });
      return true;
    }
    return false;
  }
  try {
    if (!humanTransportAllowed(request.socket, options.transportAdmission)) {
      request.resume();
      respond(response, 426, { error: "registry_insecure_transport" });
      return true;
    }
    const mutation =
      matched.kind === "register_canvas" ||
      matched.kind === "create_snapshot" ||
      matched.kind === "restore_snapshot";
    if (mutation && options.readiness && options.readiness().status !== "ready") {
      request.resume();
      respond(response, 503, { error: "server_not_accepting_mutations" });
      return true;
    }
    const context = actorForRequest(options, request);
    switch (matched.kind) {
      case "projects": {
        const page = pageQuery(url);
        respond(
          response,
          200,
          projectAccessPageSchema.parse(options.service.listProjects({ ...context, ...page }))
        );
        break;
      }
      case "canvases": {
        const page = pageQuery(url);
        // This request is ACL-filtered by the Server service; project visibility does not
        // implicitly grant sibling canvases, allowing a shared canvas in a private project.
        const project = projectAccessRequestSchema.parse({ projectId: matched.projectId });
        respond(
          response,
          200,
          canvasAccessPageSchema.parse(
            options.service.listCanvases({ ...context, ...project, ...page })
          )
        );
        break;
      }
      case "register_canvas": {
        query(url, []);
        const body = canvasAccessRequestSchema.parse(await readJson(request));
        if (body.projectId !== matched.projectId) throw new Error("registry_scope_mismatch");
        respond(
          response,
          200,
          canvasAccessRecordSchema.parse(options.service.registerCanvas({ ...context, ...body }))
        );
        break;
      }
      case "read_snapshot": {
        query(url, []);
        const canvas = canvasAccessRequestSchema.parse({
          projectId: matched.projectId,
          canvasId: matched.canvasId
        });
        respond(
          response,
          200,
          packageSnapshotSchema.parse(
            options.service.readSnapshot({ ...context, ...canvas, snapshotId: matched.snapshotId })
          )
        );
        break;
      }
      case "create_snapshot": {
        query(url, []);
        const body = createPackageSnapshotRequestSchema.parse(await readJson(request));
        assertRouteBodyScope(body, matched);
        const result = await options.service.createSnapshot({ ...context, ...body });
        respond(response, 201, createPackageSnapshotResultSchema.parse(result));
        break;
      }
      case "restore_snapshot": {
        query(url, []);
        const body = restorePackageSnapshotRequestSchema.parse(await readJson(request));
        assertRouteBodyScope(body, matched);
        const result = await options.service.restoreSnapshot({ ...context, ...body });
        const parsed = restorePackageSnapshotResultSchema.parse(result);
        respond(response, parsed.outcome === "conflict" ? 409 : 200, parsed);
        break;
      }
    }
  } catch (error) {
    const safe =
      error instanceof Error && error.message === "registry_unauthorized"
        ? { status: 401, code: "registry_unauthorized" }
        : error instanceof Error && error.message === "registry_scope_mismatch"
          ? { status: 400, code: "registry_scope_mismatch" }
          : safeError(error);
    request.resume();
    if (!response.headersSent) respond(response, safe.status, { error: safe.code });
    else response.destroy();
  }
  return true;
}
