import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ServerConfig } from "./config.js";
import type { SqliteDatabase } from "./sqlite.js";
import { DomainError } from "./identity/errors.js";
import { resolveActiveSession } from "./identity/sessions.js";
import { requireProjectRole } from "./identity/authorization.js";
import { appendMessage, listMessages } from "./planning/messages.js";
import { createProposalService, getProposal, recordApproval } from "./proposals/proposals.js";
import { createWorkRepository } from "./work/repository.js";
import { createWorkServices } from "./work/services.js";
import { WorkError } from "./work/types.js";

type Options = { database: SqliteDatabase; config: ServerConfig; readiness: () => unknown };
type Json = Record<string, unknown>;

export function createCollaborationHttpServer(options: Options): Server {
  const { database, config } = options;
  const work = createWorkServices({ repository: createWorkRepository({ database }) });
  const proposals = createProposalService({ database });

  return createServer((request, response) => {
    void route(request, response).catch((error) => writeError(response, request, error));
  });

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? config.host}`);
    const path = url.pathname;
    if (request.method === "GET" && (path === "/healthz" || path === "/readyz")) return writeJson(response, 200, options.readiness());
    if (request.method === "POST" && path === "/api/v1/join") return join(request, response);

    const identity = authenticate(request);
    const projectMatch = path.match(/^\/api\/v1\/projects\/([^/]+)(\/.*)?$/);
    const projectId = projectMatch ? decodeSegment(projectMatch[1]!) : null;
    if (projectId) requireProjectRole(database, projectId, identity.user.id, "viewer");

    if (request.method === "GET" && projectId && projectMatch?.[2] === "/snapshot") {
      const project = database.prepare("SELECT id,version,name,created_at FROM projects WHERE id=?").get(projectId);
      if (!project) throw new DomainError("not_found", "Project not found");
      const last = database.prepare("SELECT COALESCE(MAX(event_id),0) AS id FROM domain_events WHERE project_id=?").get(projectId);
      return writeJson(response, 200, { project: { id: project.id, version: project.version, name: project.name, createdAt: project.created_at }, lastEventId: String(last?.id ?? 0) });
    }
    if (request.method === "GET" && projectId && projectMatch?.[2] === "/events") {
      const after = url.searchParams.get("afterEventId") ?? "0";
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 50)));
      if (!/^\d+$/.test(after) || !Number.isInteger(limit)) throw new DomainError("validation_failed", "Invalid event cursor or limit");
      const rows = database.prepare("SELECT event_id,project_id,aggregate_type,aggregate_id,aggregate_version,type,occurred_at FROM domain_events WHERE project_id=? AND event_id>? ORDER BY event_id LIMIT ?").all(projectId, Number(after), limit);
      return writeJson(response, 200, { items: rows.map((row) => ({ protocolVersion: 1, eventId: String(row.event_id), projectId: row.project_id, aggregateType: row.aggregate_type, aggregateId: row.aggregate_id, aggregateVersion: row.aggregate_version, type: row.type, occurredAt: row.occurred_at })), nextCursor: rows.length === limit ? String(rows.at(-1)?.event_id) : null });
    }
    if (request.method === "GET" && projectId && projectMatch?.[2] === "/members") {
      const rows = database.prepare("SELECT m.user_id,u.display_name,m.role FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.project_id=? ORDER BY u.display_name").all(projectId);
      return writeJson(response, 200, rows.map((row) => ({ userId: row.user_id, displayName: row.display_name, role: row.role, online: false })));
    }
    if (request.method === "GET" && projectId && projectMatch?.[2] === "/rooms") {
      const rows = database.prepare("SELECT id,name,archived_at FROM rooms WHERE project_id=? ORDER BY created_at").all(projectId);
      return writeJson(response, 200, rows.map((row) => ({ id: row.id, name: row.name, archivedAt: row.archived_at })));
    }
    const messagesMatch = projectId && projectMatch?.[2]?.match(/^\/rooms\/([^/]+)\/messages$/);
    if (messagesMatch && request.method === "GET") {
      const result = listMessages(database, identity.session, { roomId: decodeSegment(messagesMatch[1]!), limit: 100 });
      return writeJson(response, 200, result.items);
    }
    if (messagesMatch && request.method === "POST") {
      const body = await readBody(request);
      const roomId = decodeSegment(messagesMatch[1]!);
      const result = appendMessage(database, identity.session, { deviceId: identity.session.deviceId, route: path, key: idempotency(request, body), requestFingerprint: JSON.stringify(body), roomId, body: string(body.body, "body") });
      return writeJson(response, 201, result.value.message);
    }
    if (request.method === "GET" && projectId && projectMatch?.[2] === "/proposals") {
      const rows = database.prepare("SELECT id,project_id,title,body,status,current_revision_id,version,created_by_user_id,created_at FROM proposals WHERE project_id=? ORDER BY created_at DESC").all(projectId);
      return writeJson(response, 200, rows.map((row) => ({ id: row.id, projectId: row.project_id, title: row.title, body: row.body, status: row.status, version: row.version, currentRevisionId: row.current_revision_id, createdByUserId: row.created_by_user_id, createdAt: row.created_at })));
    }
    if (request.method === "GET" && projectId && projectMatch?.[2] === "/tasks") {
      const rows = database.prepare("SELECT * FROM work_tasks WHERE project_id=? ORDER BY created_at,task_id").all(projectId);
      return writeJson(response, 200, rows.map(toTask));
    }
    if (request.method === "POST" && projectId && projectMatch?.[2] === "/tasks") {
      requireProjectRole(database, projectId, identity.user.id, "maintainer");
      const body = await readBody(request);
      const taskId = string(body.taskId, "taskId");
      const scopes = strings(body.ownershipScopes, "ownershipScopes", true);
      const checks = strings(body.acceptanceChecks, "acceptanceChecks");
      const reviewers = strings(body.reviewers, "reviewers");
      const locks = strings(body.locks, "locks");
      const dependencyIds = strings(body.dependencyIds, "dependencyIds");
      const now = new Date().toISOString();
      const serverTaskId = `task_${taskId}`;
      database.exec("BEGIN IMMEDIATE");
      try {
        database.prepare("INSERT INTO work_tasks(id,project_id,task_id,title,parallel,locks_json,ownership_scopes_json,acceptance_checks_json,reviewers_json,version,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
          .run(serverTaskId, projectId, taskId, string(body.title, "title"), body.parallel === true ? 1 : 0, JSON.stringify(locks), JSON.stringify(scopes), JSON.stringify(checks), JSON.stringify(reviewers), 1, "ready", now, now);
        for (const dependencyId of dependencyIds) database.prepare("INSERT INTO work_task_dependencies(project_id,task_id,depends_on_task_id) VALUES (?,?,?)").run(projectId, serverTaskId, dependencyId);
        database.exec("COMMIT");
      } catch (error) { database.exec("ROLLBACK"); throw error; }
      return writeJson(response, 201, toTask(database.prepare("SELECT * FROM work_tasks WHERE id=?").get(serverTaskId)!));
    }
    const approveMatch = projectId && projectMatch?.[2]?.match(/^\/proposals\/([^/]+)\/approve$/);
    if (approveMatch && request.method === "POST") {
      const body = await readBody(request);
      const proposal = getProposal(database, decodeSegment(approveMatch[1]!));
      if (!proposal.currentRevisionId) throw new DomainError("state_conflict", "Proposal has no current revision");
      const result = recordApproval(proposals, identity.session, { deviceId: identity.session.deviceId, route: path, key: idempotency(request, body), requestFingerprint: JSON.stringify(body), proposalId: proposal.id, revisionId: proposal.currentRevisionId, decision: body.decision === "reject" ? "reject" : "approve", reason: typeof body.reason === "string" ? body.reason : undefined });
      return writeJson(response, 201, result.value.approval);
    }
    const claimMatch = projectId && projectMatch?.[2]?.match(/^\/tasks\/([^/]+)\/claim$/);
    if (claimMatch && request.method === "POST") {
      requireProjectRole(database, projectId, identity.user.id, "contributor");
      const body = await readBody(request);
      const result = work.claimTask({ deviceId: identity.session.deviceId, idempotencyKey: idempotency(request, body), commandType: "claim_task", aggregateType: "task", projectId, actorId: identity.user.id, taskId: decodeSegment(claimMatch[1]!), branchName: string(body.branchName, "branchName"), baseCommit: string(body.baseCommit, "baseCommit"), leaseDurationSeconds: number(body.leaseDurationSeconds, 3600) });
      return writeJson(response, 200, { ...result.value, replayed: result.replayed });
    }
    const assignmentMatch = projectId && projectMatch?.[2]?.match(/^\/assignments\/([^/]+)\/(heartbeat|submit)$/);
    if (assignmentMatch && request.method === "POST") {
      const body = await readBody(request);
      const assignmentId = decodeSegment(assignmentMatch[1]!);
      const common = { deviceId: identity.session.deviceId, idempotencyKey: idempotency(request, body), aggregateType: "assignment" as const, aggregateId: assignmentId, projectId, actorId: identity.user.id, expectedVersion: number(body.expectedVersion, 0) };
      if (assignmentMatch[2] === "heartbeat") {
        const result = work.heartbeat({ ...common, commandType: "heartbeat", leaseDurationSeconds: number(body.leaseDurationSeconds, 3600) });
        return writeJson(response, 200, { ...result.value, replayed: result.replayed });
      }
      const result = work.submit({ ...common, commandType: "submit", headCommit: string(body.headCommit, "headCommit"), baseCommit: string(body.baseCommit, "baseCommit") });
      return writeJson(response, 201, { ...result.value, replayed: result.replayed });
    }
    if (request.method === "GET" && projectId && projectMatch?.[2] === "/merge-queue") {
      const rows = database.prepare("SELECT submission_id,head_commit,base_commit,status,created_at FROM merge_queue_entries WHERE project_id=? ORDER BY created_at").all(projectId);
      return writeJson(response, 200, { submissions: rows.map((row) => ({ submissionId: row.submission_id, headCommit: row.head_commit, baseCommit: row.base_commit, status: row.status, createdAt: row.created_at })) });
    }
    throw new DomainError("not_found", "Route not found");
  }

  async function join(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readBody(request);
    if (body.joinToken !== (config.joinToken ?? "planweave-local-team")) throw new DomainError("unauthenticated", "Invalid team join token");
    const projectId = string(body.projectId, "projectId");
    const userId = string(body.userId, "userId");
    const deviceId = string(body.deviceId, "deviceId");
    const now = new Date().toISOString();
    database.exec("BEGIN IMMEDIATE");
    try {
      if (!database.prepare("SELECT id FROM projects WHERE id=?").get(projectId)) database.prepare("INSERT INTO projects(id,name,created_at) VALUES (?,?,?)").run(projectId, typeof body.projectName === "string" ? body.projectName : projectId, now);
      if (!database.prepare("SELECT id FROM users WHERE id=?").get(userId)) database.prepare("INSERT INTO users(id,display_name,email,created_at) VALUES (?,?,?,?)").run(userId, typeof body.displayName === "string" ? body.displayName : userId, null, now);
      if (!database.prepare("SELECT id FROM devices WHERE id=?").get(deviceId)) database.prepare("INSERT INTO devices(id,user_id,device_name,public_key_fingerprint,last_seen_at,status,created_at) VALUES (?,?,?,?,?,?,?)").run(deviceId, userId, deviceId, null, now, "active", now);
      const memberCount = Number(database.prepare("SELECT COUNT(*) AS n FROM memberships WHERE project_id=?").get(projectId)?.n ?? 0);
      if (!database.prepare("SELECT role FROM memberships WHERE project_id=? AND user_id=?").get(projectId, userId)) database.prepare("INSERT INTO memberships(project_id,user_id,role,created_at) VALUES (?,?,?,?)").run(projectId, userId, memberCount === 0 ? "owner" : "contributor", now);
      const roomId = `room_${projectId}`;
      if (!database.prepare("SELECT id FROM rooms WHERE id=?").get(roomId)) database.prepare("INSERT INTO rooms(id,project_id,name,created_at,archived_at) VALUES (?,?,?,?,?)").run(roomId, projectId, "general", now, null);
      const sessionId = randomUUID();
      const expiresAt = new Date(Date.now() + 7 * 86400000).toISOString();
      database.prepare("INSERT INTO sessions(id,user_id,device_id,issued_at,expires_at,revoked_at) VALUES (?,?,?,?,?,?)").run(sessionId, userId, deviceId, now, expiresAt, null);
      database.exec("COMMIT");
      return writeJson(response, 201, { session: { id: sessionId, issuedAt: now, expiresAt }, projectId, role: memberCount === 0 ? "owner" : "contributor" });
    } catch (error) { database.exec("ROLLBACK"); throw error; }
  }

  function authenticate(request: IncomingMessage) {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw new DomainError("unauthenticated", "Bearer session is required");
    return resolveActiveSession(database, header.slice(7));
  }
}

async function readBody(request: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 1_048_576) throw new DomainError("request_too_large", "Request body exceeds 1 MiB"); chunks.push(bytes); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Json; } catch { throw new DomainError("validation_failed", "Request body must be JSON"); }
}
function string(value: unknown, field: string): string { if (typeof value !== "string" || !value.trim()) throw new DomainError("validation_failed", `${field} is required`); return value.trim(); }
function number(value: unknown, fallback: number): number { const n = value === undefined ? fallback : Number(value); if (!Number.isInteger(n) || n < 1) throw new DomainError("validation_failed", "Expected a positive integer"); return n; }
function strings(value: unknown, field: string, required = false): string[] { if (value === undefined && !required) return []; if (!Array.isArray(value) || (required && value.length === 0) || value.some((item) => typeof item !== "string" || !item.trim())) throw new DomainError("validation_failed", `${field} must be${required ? " a non-empty" : " an"} array of strings`); return value.map((item) => (item as string).trim()); }
function jsonStrings(value: unknown): string[] { try { const parsed = JSON.parse(String(value)) as unknown; return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []; } catch { return []; } }
function toTask(row: Record<string, unknown>): Json { return { id: row.id, taskId: row.task_id, title: row.title, status: row.status, version: row.version, policy: { parallel: row.parallel === 1, locks: jsonStrings(row.locks_json), ownershipScopes: jsonStrings(row.ownership_scopes_json), acceptanceChecks: jsonStrings(row.acceptance_checks_json), reviewers: jsonStrings(row.reviewers_json) } }; }
function decodeSegment(value: string): string { try { const decoded = decodeURIComponent(value); if (!decoded || decoded.includes("/") || decoded.includes("\\")) throw new Error(); return decoded; } catch { throw new DomainError("validation_failed", "Invalid path segment"); } }
function idempotency(request: IncomingMessage, body: Json): string { const value = request.headers["idempotency-key"] ?? body.idempotencyKey; return typeof value === "string" && value.length >= 16 ? value : randomUUID(); }
function writeJson(response: ServerResponse, status: number, body: unknown): void { response.writeHead(status, { "content-type": "application/json; charset=utf-8" }); response.end(JSON.stringify(body)); }
function writeError(response: ServerResponse, request: IncomingMessage, error: unknown): void {
  const requestId = typeof request.headers["x-request-id"] === "string" ? request.headers["x-request-id"] : randomUUID();
  const code = error instanceof DomainError || error instanceof WorkError ? error.code : "internal_error";
  const status: Record<string, number> = { unauthenticated: 401, forbidden: 403, not_found: 404, state_conflict: 409, version_conflict: 409, request_too_large: 413, validation_failed: 422 };
  writeJson(response, status[code] ?? 500, { error: { code, message: error instanceof Error ? error.message : "Internal server error", requestId, retryable: false, details: error instanceof DomainError || error instanceof WorkError ? error.details : undefined } });
}
