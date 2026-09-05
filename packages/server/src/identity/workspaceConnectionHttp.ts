import type { IncomingMessage, ServerResponse } from "node:http";
import {
  HUMAN_MAX_MEMBERS_LISTED_PER_PAGE,
  WORKSPACE_PICKER_MAX_ITEMS_PER_PAGE
} from "@planweave-ai/collaboration-protocol/core/limits";
import { humanDeviceTokenSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import {
  workspaceConnectionSelfUpdateRequestSchema,
  workspacePickerPageSchema
} from "@planweave-ai/collaboration-protocol/connection";
import { assertSetupViewRedacted } from "@planweave-ai/collaboration-protocol/setup";
import { humanTransportAllowed } from "./http.js";
import type { TransportAdmissionPolicy } from "../insecureTransport.js";
import { WorkspaceIdentityRepository } from "./workspaceRepository.js";

const MAX_BODY_BYTES = 16_384;

export type WorkspaceConnectionHttpOptions = {
  workspaceIdentity: WorkspaceIdentityRepository;
  transportAdmission: TransportAdmissionPolicy;
};

type WorkspaceConnectionRoute = "picker" | "self" | "members";

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

function pageQuery(url: URL, maxLimit: number): { cursor: number; limit: number } {
  const allowed = new Set(["cursor", "limit"]);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) {
      throw new Error("workspace_connection_query_invalid");
    }
  }
  const parse = (key: "cursor" | "limit", fallback: number): number => {
    const value = url.searchParams.get(key);
    if (value === null) return fallback;
    if (!/^\d+$/.test(value)) throw new Error("workspace_connection_query_invalid");
    const number = Number(value);
    if (!Number.isSafeInteger(number)) throw new Error("workspace_connection_query_invalid");
    return number;
  };
  const cursor = parse("cursor", 0);
  const limit = parse("limit", maxLimit);
  if (limit < 1 || limit > maxLimit) {
    throw new Error("workspace_connection_query_invalid");
  }
  return { cursor, limit };
}

function workspaceDeviceBearer(authorization: string | string[] | undefined): string | undefined {
  if (Array.isArray(authorization) || authorization === undefined) return undefined;
  const match = /^Bearer (.+)$/.exec(authorization);
  if (!match) return undefined;
  const token = match[1]?.trim();
  const parsed = token ? humanDeviceTokenSchema.safeParse(token) : undefined;
  return parsed?.success ? parsed.data : undefined;
}

function route(method: string, pathname: string): WorkspaceConnectionRoute | undefined {
  if (pathname === "/api/v1/workspace-connection") {
    return method === "GET" ? "picker" : undefined;
  }
  if (pathname === "/api/v1/workspace-connection/self") {
    return method === "GET" || method === "PATCH" ? "self" : undefined;
  }
  if (pathname === "/api/v1/workspace-connection/members") {
    return method === "GET" ? "members" : undefined;
  }
  return undefined;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? "")) {
    throw new Error("workspace_connection_input_invalid");
  }
  const declaredLength = request.headers["content-length"];
  if (Array.isArray(declaredLength)) throw new Error("workspace_connection_input_invalid");
  if (
    declaredLength &&
    (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_BODY_BYTES)
  ) {
    throw new Error("workspace_connection_body_too_large");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_BODY_BYTES) throw new Error("workspace_connection_body_too_large");
    chunks.push(bytes);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("workspace_connection_input_invalid");
  }
}

function errorStatus(error: unknown): number {
  if (!(error instanceof Error)) return 500;
  if (error.message === "workspace_connection_query_invalid") return 400;
  if (error.message === "workspace_connection_input_invalid") return 400;
  if (error.message === "workspace_connection_body_too_large") return 413;
  return 400;
}

export async function handleWorkspaceConnectionHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: WorkspaceConnectionHttpOptions
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://planweave.invalid");
  const matched = route(request.method ?? "GET", url.pathname);
  if (!matched) {
    if (url.pathname.startsWith("/api/v1/workspace-connection")) {
      request.resume();
      respond(response, 404, { error: "workspace_connection_not_found" });
      return true;
    }
    return false;
  }
  if (!humanTransportAllowed(request.socket, options.transportAdmission)) {
    request.resume();
    respond(response, 426, { error: "workspace_connection_insecure_transport" });
    return true;
  }
  const token = workspaceDeviceBearer(request.headers.authorization);
  if (!token) {
    request.resume();
    respond(response, 401, { error: "workspace_connection_unauthorized" });
    return true;
  }
  try {
    if (matched === "picker") {
      const { cursor, limit } = pageQuery(url, WORKSPACE_PICKER_MAX_ITEMS_PER_PAGE);
      const authenticated = options.workspaceIdentity.authenticateWorkspaceDevice(token);
      if (!authenticated) {
        respond(response, 401, { error: "workspace_connection_unauthorized" });
        return true;
      }
      const items = options.workspaceIdentity.listActiveWorkspacePickerItems(
        authenticated.humanPrincipalId
      );
      const page = workspacePickerPageSchema.parse({
        schemaVersion: "workspace-setup/v1",
        items: items.slice(cursor, cursor + limit),
        nextCursor: cursor + limit < items.length ? cursor + limit : null
      });
      assertSetupViewRedacted(page);
      respond(response, 200, page);
      return true;
    }
    if (matched === "self") {
      if (request.method === "PATCH") {
        const body = workspaceConnectionSelfUpdateRequestSchema.parse(await readJson(request));
        const updated = options.workspaceIdentity.updateWorkspaceConnectionDisplayName(
          token,
          body.displayName
        );
        if (!updated) {
          respond(response, 401, { error: "workspace_connection_unauthorized" });
          return true;
        }
        assertSetupViewRedacted(updated);
        respond(response, 200, updated);
        return true;
      }
      if ([...url.searchParams.keys()].length > 0) {
        throw new Error("workspace_connection_query_invalid");
      }
      const self = options.workspaceIdentity.readWorkspaceConnectionSelf(token);
      if (!self) {
        respond(response, 401, { error: "workspace_connection_unauthorized" });
        return true;
      }
      assertSetupViewRedacted(self);
      respond(response, 200, self);
      return true;
    }
    const { cursor, limit } = pageQuery(url, HUMAN_MAX_MEMBERS_LISTED_PER_PAGE);
    const members = options.workspaceIdentity.listWorkspaceConnectionMembers(token, cursor, limit);
    if (!members) {
      respond(response, 401, { error: "workspace_connection_unauthorized" });
      return true;
    }
    assertSetupViewRedacted(members);
    respond(response, 200, members);
    return true;
  } catch (error) {
    request.resume();
    respond(response, errorStatus(error), {
      error:
        error instanceof Error &&
        (error.message === "workspace_connection_query_invalid" ||
          error.message === "workspace_connection_input_invalid" ||
          error.message === "workspace_connection_body_too_large")
          ? error.message
          : "workspace_connection_request_failed"
    });
  }
  return true;
}
