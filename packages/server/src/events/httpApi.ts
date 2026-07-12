import type { IncomingMessage, ServerResponse, Server } from "node:http";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { SqliteDatabase } from "../sqlite.js";
import { readEventsPage, readOldestEventIdWithinRetention, readProjectSnapshot, RepositoryError } from "./repository.js";
import { writeApiError } from "./errors.js";
import type { Authenticator, Page, EventEnvelopeV1, ProjectSnapshotV1 } from "./types.js";
import { DEFAULT_RETENTION_MS } from "./types.js";

// HTTP event-replay + snapshot API.
//
// Routes (per CONTRACTS-v1.md "Durable event and WebSocket contracts"):
//   GET /api/v1/projects/{projectId}/events?afterEventId={decimal-id}&limit={1..100}
//     → 200 Page<EventEnvelopeV1>
//     → 401 unauthenticated, 403 forbidden, 404 not_found
//     → 410 event_cursor_expired (afterEventId older than retention window)
//     → 422 validation_failed (bad query params)
//     → 400 cursor_invalid (malformed afterEventId)
//
//   GET /api/v1/projects/{projectId}/snapshot
//     → 200 ProjectSnapshotV1 ({ project, lastEventId })
//     → 401 unauthenticated, 403 forbidden, 404 not_found
//
// Both routes require authentication. The configured `Authenticator` is called with the
// request headers + URL. A3 will provide the production authenticator that maps the
// `projectId` path parameter to the authenticated identity.

export type EventHttpApiOptions = {
  database: SqliteDatabase;
  authenticator: Authenticator;
  // Retention window in milliseconds. `afterEventId` smaller than the smallest event_id
  // within this window returns 410 event_cursor_expired.
  retentionMs?: number;
  // Test seam: override the clock for retention comparisons.
  now?: () => Date;
};

export type EventHttpApi = {
  server: Server;
  address(): { port: number; host: string } | null;
  start(): Promise<void>;
  close(): Promise<void>;
};

const EVENTS_RE = /^\/api\/v1\/projects\/([^/]+)\/events$/;
const SNAPSHOT_RE = /^\/api\/v1\/projects\/([^/]+)\/snapshot$/;

export function createEventHttpApi(options: EventHttpApiOptions): EventHttpApi {
  const retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
  const now = options.now ?? (() => new Date());
  const database = options.database;

  function requestId(headers: IncomingMessage["headers"]): string {
    const supplied = headers["x-request-id"];
    if (typeof supplied === "string" && supplied.length > 0 && supplied.length <= 128) return supplied;
    return randomUUID();
  }

  function pathParams(headers: IncomingMessage["headers"]): Record<string, string | string[] | undefined> {
    const out: Record<string, string | string[] | undefined> = {};
    for (const [k, v] of Object.entries(headers)) out[k] = v;
    return out;
  }

  async function authenticate(request: IncomingMessage, response: ServerResponse, projectId: string): Promise<{ ok: true; userId: string; sessionId: string; role: string } | null> {
    const result = await options.authenticator({ headers: pathParams(request.headers), url: request.url, projectId });
    if (!result.ok) {
      const code = result.reason === "unauthenticated" ? "unauthenticated" : "forbidden";
      const message = result.reason === "unauthenticated" ? "Authentication is required to access this resource." : "You do not have permission to access this resource.";
      writeApiError(response, code, message, requestId(request.headers));
      return null;
    }
    if (result.identity.projectId !== projectId) {
      writeApiError(response, "forbidden", "You do not have permission to access this resource.", requestId(request.headers));
      return null;
    }
    return { ok: true, userId: result.identity.userId, sessionId: result.identity.sessionId, role: result.identity.role };
  }

  async function handleEvents(request: IncomingMessage, response: ServerResponse, projectId: string): Promise<void> {
    const rid = requestId(request.headers);
    const auth = await authenticate(request, response, projectId);
    if (!auth) return;
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const afterEventIdRaw = url.searchParams.get("afterEventId") ?? "0";
    if (!/^\d+$/.test(afterEventIdRaw)) {
      writeApiError(response, "cursor_invalid", "afterEventId must be a decimal integer", rid, { afterEventId: afterEventIdRaw });
      return;
    }
    const limitRaw = url.searchParams.get("limit") ?? "50";
    const limit = Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      writeApiError(response, "validation_failed", "limit must be an integer between 1 and 100", rid, { limit: limitRaw });
      return;
    }
    // Retention check: if no event in the DB is within the retention window, the cursor
    // is treated as expired (the client must take a fresh snapshot+resync). Otherwise,
    // if the requested afterEventId is older than the smallest durable event id within
    // the retention window, the cursor is expired.
    const oldestWithin = readOldestEventIdWithinRetention(database, { projectId, retentionMs, nowMs: now().getTime() });
    if (oldestWithin === "0") {
      // No events in retention — but if there are NO events at all in the DB, this is a
      // legitimately empty page (afterEventId=0 returns nothing). Distinguish by also
      // checking the absolute count.
      const count = (database.prepare("SELECT COUNT(*) AS c FROM domain_events WHERE project_id = ?").get(projectId) as { c: number } | undefined)?.c ?? 0;
      if (count > 0) {
        writeApiError(response, "event_cursor_expired", "The requested afterEventId is older than the server retention window. Fetch a fresh snapshot and resync.", rid, { afterEventId: afterEventIdRaw, oldestAvailableEventId: null });
        return;
      }
    } else if (afterEventIdRaw !== "0" && BigInt(afterEventIdRaw) < BigInt(oldestWithin)) {
      writeApiError(response, "event_cursor_expired", "The requested afterEventId is older than the server retention window. Fetch a fresh snapshot and resync.", rid, { afterEventId: afterEventIdRaw, oldestAvailableEventId: oldestWithin });
      return;
    }
    let page: Page<EventEnvelopeV1>;
    try {
      page = readEventsPage(database, { projectId, afterEventId: afterEventIdRaw, limit });
    } catch (error) {
      if (error instanceof RepositoryError) {
        const code = error.code === "not_found" ? "not_found" : error.code === "cursor_invalid" ? "cursor_invalid" : "validation_failed";
        writeApiError(response, code, error.message, rid);
        return;
      }
      throw error;
    }
    response.writeHead(200, { "content-type": "application/json; charset=utf-8", "x-request-id": rid });
    response.end(JSON.stringify(page));
  }

  async function handleSnapshot(request: IncomingMessage, response: ServerResponse, projectId: string): Promise<void> {
    const rid = requestId(request.headers);
    const auth = await authenticate(request, response, projectId);
    if (!auth) return;
    let snapshot: ProjectSnapshotV1;
    try {
      snapshot = readProjectSnapshot(database, projectId);
    } catch (error) {
      if (error instanceof RepositoryError && error.code === "not_found") {
        writeApiError(response, "not_found", `Project ${projectId} not found`, rid);
        return;
      }
      throw error;
    }
    response.writeHead(200, { "content-type": "application/json; charset=utf-8", "x-request-id": rid });
    response.end(JSON.stringify(snapshot));
  }

  const server = createServer(async (request, response) => {
    if (!request.url) {
      writeApiError(response, "validation_failed", "Missing URL", requestId(request.headers));
      return;
    }
    const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
    const path = url.pathname;
    if (request.method !== "GET") {
      writeApiError(response, "validation_failed", `Method ${request.method} not allowed`, requestId(request.headers));
      return;
    }
    const eventsMatch = path.match(EVENTS_RE);
    if (eventsMatch) {
      const projectId = decodeURIComponent(eventsMatch[1]!);
      await handleEvents(request, response, projectId);
      return;
    }
    const snapshotMatch = path.match(SNAPSHOT_RE);
    if (snapshotMatch) {
      const projectId = decodeURIComponent(snapshotMatch[1]!);
      await handleSnapshot(request, response, projectId);
      return;
    }
    if (path === "/healthz" || path === "/readyz") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ status: "ready" }));
      return;
    }
    writeApiError(response, "not_found", "Not found", requestId(request.headers));
  });

  return {
    server,
    address() {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        const a = addr as AddressInfo;
        return { port: a.port, host: a.address };
      }
      return null;
    },
    async start() {
      if (server.listening) return;
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
    },
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
