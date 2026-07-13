import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join as joinPath } from "node:path";
import type { ServerConfig } from "./config.js";
import type { SqliteDatabase } from "./sqlite.js";
import { DomainError } from "./identity/errors.js";
import { resolveActiveSession } from "./identity/sessions.js";
import { requireProjectRole } from "./identity/authorization.js";
import { lookupProjectRole } from "./identity/authorization.js";
import { appendMessage, listMessages } from "./planning/messages.js";
import { createProposalService, getProposal, recordApproval } from "./proposals/proposals.js";
import { createWorkRepository } from "./work/repository.js";
import { createWorkServices } from "./work/services.js";
import { WorkError } from "./work/types.js";
import { serverTaskId } from "./work/taskIds.js";
import { createEventPublisher, createEventWebSocketServer, type Authenticator } from "./events/index.js";
import { executeIdempotent } from "./store.js";
import { createMergeQueueServices } from "./git/mergeQueue.js";
import { importSubmissionBundle } from "./git/bundleTransport.js";
import { MergeQueueError } from "./git/types.js";
import { completeAttachment, createAttachmentService, readAttachmentAuthorized, startAttachment, writeStagedBytes } from "./attachments/index.js";
import {
  createConsensusBaseline,
  decideConsensusBaseline,
  freezeConsensusBaseline,
  getCoordinationSnapshot,
  recordSubmissionEvidence,
  registerMemberAgent,
  setTaskPreference,
  type BaselineCitation,
  type MemberAgentProfile,
  type SubmissionEvidence
} from "./coordination/index.js";

type Options = { database: SqliteDatabase; config: ServerConfig; readiness: () => unknown };
type Json = Record<string, unknown>;
const MEMBER_PRESENCE_WINDOW_MS = 60_000;
const LEASE_RECLAIM_INTERVAL_MS = 5_000;

export function createCollaborationHttpServer(options: Options): Server {
  const { database, config } = options;
  const work = createWorkServices({ repository: createWorkRepository({ database }) });
  const proposals = createProposalService({ database });
  const attachments = createAttachmentService({ database, dataDirectory: config.dataDirectory });
  const bareRepoPath = joinPath(config.dataDirectory, "integration.git");
  const mergeQueue = config.repositoryPath ? createMergeQueueServices({ database, config: { dataDirectory: config.dataDirectory, bareRepoPath, sourceRepoPath: config.repositoryPath, checks: config.repositoryChecks, checkExecutionMode: "host", requireApproval: config.requireMergeApproval ?? true } }) : null;

  const server = createServer((request, response) => {
    void route(request, response).catch((error) => writeError(response, request, error));
  });
  const eventAuthenticator: Authenticator = async (input) => {
    try {
      const authorization = input.headers?.authorization;
      const rawAuthorization = Array.isArray(authorization) ? authorization[0] : authorization;
      if (!rawAuthorization?.startsWith("Bearer ")) return { ok: false, reason: "unauthenticated" };
      const identity = resolveActiveSession(database, rawAuthorization.slice(7));
      if (input.userId && input.userId !== identity.user.id) return { ok: false, reason: "unauthenticated" };
      if (input.sessionId && input.sessionId !== identity.session.id) return { ok: false, reason: "unauthenticated" };
      const projectHeader = input.headers?.["x-planweave-project-id"];
      const headerProjectId = Array.isArray(projectHeader) ? projectHeader[0] : projectHeader;
      const urlProjectId = input.url ? new URL(input.url, "http://localhost").searchParams.get("projectId") : null;
      const projectId = input.projectId ?? headerProjectId ?? urlProjectId;
      if (!projectId) return { ok: false, reason: "forbidden" };
      const role = lookupProjectRole(database, projectId, identity.user.id);
      if (!role) return { ok: false, reason: "forbidden" };
      return { ok: true, identity: { userId: identity.user.id, sessionId: identity.session.id, projectId, role } };
    } catch {
      return { ok: false, reason: "unauthenticated" };
    }
  };
  const eventPublisher = createEventPublisher({
    database,
    authenticator: eventAuthenticator,
    sessionRevocation: async (input) => {
      const result = await eventAuthenticator({ userId: input.userId, sessionId: input.sessionId, projectId: input.projectId, headers: { authorization: `Bearer ${input.sessionId}` } });
      return result.ok ? { ok: true, role: result.identity.role } : result;
    }
  });
  const eventWebSocketServer = createEventWebSocketServer({ httpServer: server, publisher: eventPublisher, authenticator: eventAuthenticator });
  let leaseReclaimTimer: ReturnType<typeof setInterval> | null = null;
  server.once("listening", () => {
    eventPublisher.start();
    try { work.reclaimExpiredLeases(); } catch { /* retry on the next lifecycle tick */ }
    leaseReclaimTimer = setInterval(() => {
      try { work.reclaimExpiredLeases(); } catch { /* keep the server alive and retry */ }
    }, LEASE_RECLAIM_INTERVAL_MS);
    leaseReclaimTimer.unref();
  });
  server.once("close", () => {
    eventPublisher.stop();
    void eventWebSocketServer.close();
    if (leaseReclaimTimer) clearInterval(leaseReclaimTimer);
    leaseReclaimTimer = null;
  });
  return server;

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? config.host}`);
    const path = url.pathname;
    if (request.method === "GET" && (path === "/healthz" || path === "/readyz")) return writeJson(response, 200, options.readiness());
    if (request.method === "POST" && path === "/api/v1/join") return join(request, response);
    if (request.method === "POST" && path === "/api/v1/resume") return resume(request, response);

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
      const presenceCutoff = new Date(Date.now() - MEMBER_PRESENCE_WINDOW_MS).toISOString();
      const rows = database.prepare("SELECT m.user_id,u.display_name,m.role,EXISTS (SELECT 1 FROM devices d WHERE d.user_id=m.user_id AND d.status='active' AND d.last_seen_at IS NOT NULL AND d.last_seen_at>=?) AS online FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.project_id=? ORDER BY u.display_name").all(presenceCutoff, projectId);
      return writeJson(response, 200, rows.map((row) => ({ userId: row.user_id, displayName: row.display_name, role: row.role, online: Boolean(row.online) })));
    }
    if (request.method === "GET" && projectId && projectMatch?.[2] === "/rooms") {
      const rows = database.prepare("SELECT id,name,archived_at FROM rooms WHERE project_id=? ORDER BY created_at").all(projectId);
      return writeJson(response, 200, rows.map((row) => ({ id: row.id, name: row.name, archivedAt: row.archived_at })));
    }
    if (request.method === "GET" && projectId && projectMatch?.[2] === "/attachments") {
      const rows = database.prepare("SELECT id,project_id,uploader_user_id,declared_size,actual_size,actual_digest,status,original_name,media_type,created_at,promoted_at FROM attachments WHERE project_id=? AND status IN ('ready','superseded') ORDER BY created_at").all(projectId);
      return writeJson(response, 200, rows.map((row) => ({ id: row.id, projectId: row.project_id, uploaderUserId: row.uploader_user_id, size: row.actual_size ?? row.declared_size, digest: row.actual_digest, status: row.status, originalName: row.original_name, mediaType: row.media_type, createdAt: row.created_at, promotedAt: row.promoted_at })));
    }
    if (request.method === "POST" && projectId && projectMatch?.[2] === "/attachments") {
      requireProjectRole(database, projectId, identity.user.id, "contributor");
      const bytes = await readRawBody(request, attachments.policy.maxSizeBytes);
      if (bytes.length === 0) throw new DomainError("validation_failed", "Attachment must not be empty");
      const originalName = headerString(request, "x-planweave-file-name");
      const mediaType = typeof request.headers["content-type"] === "string" ? request.headers["content-type"].split(";")[0]!.trim() : "application/octet-stream";
      const digest = createHash("sha256").update(bytes).digest("hex");
      const key = idempotency(request, { digest, originalName });
      const staged = startAttachment(attachments, identity.session, { deviceId: identity.session.deviceId, route: path, key, requestFingerprint: `${projectId}:${digest}:${originalName}`, projectId, declaredSize: bytes.length, declaredDigest: digest, originalName, mediaType });
      writeStagedBytes(attachments, identity.session, staged.value.attachment.id, bytes);
      const completed = completeAttachment(attachments, identity.session, { deviceId: identity.session.deviceId, route: `${path}/complete`, key: `${key}:complete`.slice(0, 128), requestFingerprint: staged.value.attachment.id, id: staged.value.attachment.id });
      return writeJson(response, 201, completed.value.attachment);
    }
    const attachmentMatch = projectId && projectMatch?.[2]?.match(/^\/attachments\/([^/]+)$/);
    if (attachmentMatch && request.method === "GET") {
      const item = readAttachmentAuthorized(attachments, identity.session, decodeSegment(attachmentMatch[1]!));
      if (item.attachment.projectId !== projectId) throw new DomainError("not_found", "Attachment not found");
      const bytes = await readFile(item.canonicalPath);
      response.writeHead(200, { "content-type": item.attachment.mediaType, "content-length": String(bytes.length), "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(item.attachment.originalName)}` });
      response.end(bytes);
      return;
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
    if (request.method === "GET" && projectId && projectMatch?.[2] === "/coordination") {
      return writeJson(response, 200, getCoordinationSnapshot(database, projectId));
    }
    if (request.method === "POST" && projectId && projectMatch?.[2] === "/baselines") {
      const body = await readBody(request);
      const citations = Array.isArray(body.citations) ? body.citations.filter((item): item is BaselineCitation => typeof item === "object" && item !== null && ((item as BaselineCitation).kind === "message" || (item as BaselineCitation).kind === "attachment") && typeof (item as BaselineCitation).id === "string") : [];
      const baseline = createConsensusBaseline(database, mutationContext(request, path, projectId, identity.user.id, identity.session.deviceId, body), {
        title: string(body.title, "title"), summary: typeof body.summary === "string" ? body.summary : "", requirements: strings(body.requirements, "requirements"), constraints: strings(body.constraints, "constraints"), decisions: strings(body.decisions, "decisions"), acceptanceCriteria: strings(body.acceptanceCriteria, "acceptanceCriteria"), risks: strings(body.risks, "risks"), openQuestions: strings(body.openQuestions, "openQuestions"), citations
      });
      return writeJson(response, 201, baseline);
    }
    const baselineDecisionMatch = projectId && projectMatch?.[2]?.match(/^\/baselines\/([^/]+)\/(decision|freeze)$/);
    if (baselineDecisionMatch && request.method === "POST") {
      const body = await readBody(request);
      const baselineId = decodeSegment(baselineDecisionMatch[1]!);
      const context = mutationContext(request, path, projectId, identity.user.id, identity.session.deviceId, body);
      if (baselineDecisionMatch[2] === "freeze") return writeJson(response, 200, freezeConsensusBaseline(database, context, baselineId));
      if (body.decision !== "approve" && body.decision !== "reject") throw new DomainError("validation_failed", "decision must be approve or reject");
      return writeJson(response, 200, decideConsensusBaseline(database, context, baselineId, body.decision, typeof body.reason === "string" ? body.reason : undefined));
    }
    if (request.method === "POST" && projectId && projectMatch?.[2] === "/agent-profile") {
      const body = await readBody(request);
      const kind = string(body.kind, "kind") as MemberAgentProfile["kind"];
      const profile = registerMemberAgent(database, mutationContext(request, path, projectId, identity.user.id, identity.session.deviceId, body), { kind, name: string(body.name, "name"), version: typeof body.version === "string" ? body.version : null, capabilities: strings(body.capabilities, "capabilities") });
      return writeJson(response, 200, profile);
    }
    if (request.method === "GET" && projectId && projectMatch?.[2] === "/tasks") {
      const rows = database.prepare("SELECT * FROM work_tasks WHERE project_id=? ORDER BY created_at,task_id").all(projectId);
      return writeJson(response, 200, rows.map((row) => ({
        ...toTask(row),
        dependsOnTaskIds: database.prepare("SELECT depends_on_task_id FROM work_task_dependencies WHERE project_id=? AND task_id=? ORDER BY depends_on_task_id").all(projectId, row.id).map((dependency) => dependency.depends_on_task_id)
      })));
    }
    if (request.method === "POST" && projectId && projectMatch?.[2] === "/tasks") {
      requireProjectRole(database, projectId, identity.user.id, "maintainer");
      const body = await readBody(request);
      const taskId = string(body.taskId, "taskId");
      const scopes = strings(body.ownershipScopes, "ownershipScopes", true);
      const checks = strings(body.acceptanceChecks, "acceptanceChecks");
      validateOwnershipScopes(scopes);
      validateAcceptanceChecks(checks);
      const reviewers = strings(body.reviewers, "reviewers");
      const locks = strings(body.locks, "locks");
      const dependencyIds = strings(body.dependencyIds, "dependencyIds");
      const description = typeof body.description === "string" ? body.description.trim() : "";
      const requirementIds = strings(body.requirementIds, "requirementIds");
      const activeBaseline = database.prepare("SELECT active_baseline_id FROM project_coordination WHERE project_id=?").get(projectId)?.active_baseline_id;
      const baselineId = typeof body.baselineId === "string" ? body.baselineId : activeBaseline === null || activeBaseline === undefined ? null : String(activeBaseline);
      if (activeBaseline && baselineId !== activeBaseline) throw new DomainError("state_conflict", "Tasks must reference the active frozen baseline");
      if (baselineId && !database.prepare("SELECT id FROM consensus_baselines WHERE id=? AND project_id=? AND status='frozen'").get(baselineId, projectId)) throw new DomainError("state_conflict", "Task baseline must be frozen");
      const taskRowId = serverTaskId(projectId, taskId);
      const title = string(body.title, "title");
      const result = executeIdempotent(database, { deviceId: identity.session.deviceId, route: path, projectId, key: idempotency(request, body), requestFingerprint: JSON.stringify(body), execute: (unit) => {
        const now = new Date().toISOString();
        if (unit.database.prepare("SELECT id FROM work_tasks WHERE id=?").get(taskRowId)) throw new DomainError("state_conflict", `Task '${taskId}' already exists`);
        unit.database.prepare("INSERT INTO work_tasks(id,project_id,task_id,title,description,baseline_id,requirement_ids_json,parallel,locks_json,ownership_scopes_json,acceptance_checks_json,reviewers_json,version,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
          .run(taskRowId, projectId, taskId, title, description, baselineId, JSON.stringify(requirementIds), body.parallel === true ? 1 : 0, JSON.stringify(locks), JSON.stringify(scopes), JSON.stringify(checks), JSON.stringify(reviewers), 1, "ready", now, now);
        for (const dependencyId of dependencyIds) {
          const dependency = unit.database.prepare("SELECT id FROM work_tasks WHERE project_id=? AND (id=? OR task_id=?)").get(projectId, dependencyId, dependencyId);
          if (!dependency) throw new DomainError("validation_failed", `Dependency '${dependencyId}' does not exist in this project`);
          unit.database.prepare("INSERT INTO work_task_dependencies(project_id,task_id,depends_on_task_id) VALUES (?,?,?)").run(projectId, taskRowId, String(dependency.id));
        }
        unit.appendEvent({ projectId, aggregateType: "task", aggregateId: taskRowId, aggregateVersion: 1, type: "task.created" });
        unit.audit({ projectId, actorId: identity.user.id, action: "task.create", aggregateType: "task", aggregateId: taskRowId, details: { baselineId, requirementIds } });
        return toTask(unit.database.prepare("SELECT * FROM work_tasks WHERE id=?").get(taskRowId)!);
      }});
      return writeJson(response, 201, { ...result.value, replayed: result.replayed });
    }
    const preferenceMatch = projectId && projectMatch?.[2]?.match(/^\/tasks\/([^/]+)\/preference$/);
    if (preferenceMatch && request.method === "POST") {
      const body = await readBody(request);
      return writeJson(response, 200, setTaskPreference(database, mutationContext(request, path, projectId, identity.user.id, identity.session.deviceId, body), decodeSegment(preferenceMatch[1]!), typeof body.note === "string" ? body.note : ""));
    }
    const approveMatch = projectId && projectMatch?.[2]?.match(/^\/proposals\/([^/]+)\/approve$/);
    if (approveMatch && request.method === "POST") {
      const body = await readBody(request);
      if (body.decision !== "approve" && body.decision !== "reject") throw new DomainError("validation_failed", "decision must be 'approve' or 'reject'");
      const proposal = getProposal(database, decodeSegment(approveMatch[1]!));
      if (!proposal.currentRevisionId) throw new DomainError("state_conflict", "Proposal has no current revision");
      const result = recordApproval(proposals, identity.session, { deviceId: identity.session.deviceId, route: path, key: idempotency(request, body), requestFingerprint: JSON.stringify(body), proposalId: proposal.id, revisionId: proposal.currentRevisionId, decision: body.decision, reason: typeof body.reason === "string" ? body.reason : undefined });
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
      requireProjectRole(database, projectId, identity.user.id, "contributor");
      const body = await readBody(request);
      const assignmentId = decodeSegment(assignmentMatch[1]!);
      const common = { deviceId: identity.session.deviceId, idempotencyKey: idempotency(request, body), aggregateType: "assignment" as const, aggregateId: assignmentId, projectId, actorId: identity.user.id, expectedVersion: number(body.expectedVersion, 0) };
      if (assignmentMatch[2] === "heartbeat") {
        const result = work.heartbeat({ ...common, commandType: "heartbeat", leaseDurationSeconds: number(body.leaseDurationSeconds, 3600) });
        return writeJson(response, 200, { ...result.value, replayed: result.replayed });
      }
      const result = work.submit({ ...common, commandType: "submit", headCommit: string(body.headCommit, "headCommit"), baseCommit: string(body.baseCommit, "baseCommit") });
      const evidence = recordSubmissionEvidence(database, mutationContext(request, `${path}/evidence`, projectId, identity.user.id, identity.session.deviceId, { submissionId: result.value.submission.id, localChecks: body.localChecks, agentReport: body.agentReport }), result.value.submission.id, { localChecks: Array.isArray(body.localChecks) ? body.localChecks as SubmissionEvidence["localChecks"] : [], agentReport: typeof body.agentReport === "string" ? body.agentReport : null });
      return writeJson(response, 201, { ...result.value, evidence, replayed: result.replayed });
    }
    if (request.method === "GET" && projectId && projectMatch?.[2] === "/assignments") {
      const rows = database.prepare("SELECT a.*,t.task_id AS public_task_id,t.title AS task_title FROM work_assignments a JOIN work_tasks t ON t.id=a.task_id WHERE a.project_id=? AND (?=0 OR a.assignee_user_id=?) ORDER BY a.created_at DESC").all(projectId, url.searchParams.get("mine") === "1" ? 1 : 0, identity.user.id);
      return writeJson(response, 200, rows.map((row) => ({ id: row.id, projectId: row.project_id, taskId: row.public_task_id, taskTitle: row.task_title, assigneeUserId: row.assignee_user_id, status: row.status, version: row.version, branchName: row.branch_name, baseCommit: row.base_commit, leaseExpiresAt: row.lease_expires_at, currentSubmissionId: row.current_submission_id, createdAt: row.created_at, updatedAt: row.updated_at })));
    }
    if (request.method === "GET" && projectId && projectMatch?.[2] === "/merge-queue") {
      const rows = database.prepare("SELECT id,submission_id,head_commit,base_commit,target_branch,status,check_logs,review_verdict,error_details,agent_review,agent_verdict,agent_reviewed_at,source_projection_status,source_projection_details,created_at,updated_at FROM merge_queue_entries WHERE project_id=? ORDER BY created_at").all(projectId);
      return writeJson(response, 200, { configured: mergeQueue !== null, submissions: rows.map((row) => ({ entryId: row.id, submissionId: row.submission_id, headCommit: row.head_commit, baseCommit: row.base_commit, targetBranch: row.target_branch, status: row.status, checkLogs: safeJson(row.check_logs), reviewVerdict: row.review_verdict, error: row.error_details, agentReview: row.agent_review, agentVerdict: row.agent_verdict, agentReviewedAt: row.agent_reviewed_at, sourceProjectionStatus: row.source_projection_status, sourceProjectionDetails: row.source_projection_details, createdAt: row.created_at, updatedAt: row.updated_at })) });
    }
    const bundleMatch = projectId && projectMatch?.[2]?.match(/^\/submissions\/([^/]+)\/bundle$/);
    if (bundleMatch && request.method === "POST") {
      if (!mergeQueue) throw new DomainError("state_conflict", "Host integration repository is not configured");
      const submissionId = decodeSegment(bundleMatch[1]!);
      const row = database.prepare("SELECT s.id,s.head_commit,s.base_commit,a.assignee_user_id,e.local_checks_json,e.agent_report FROM work_submissions s JOIN work_assignments a ON a.id=s.assignment_id JOIN submission_evidence e ON e.submission_id=s.id WHERE s.id=? AND s.project_id=?").get(submissionId, projectId);
      if (!row) throw new DomainError("not_found", "Submission or evidence not found");
      const role = requireProjectRole(database, projectId, identity.user.id, "contributor");
      if (row.assignee_user_id !== identity.user.id && role !== "maintainer" && role !== "owner") throw new DomainError("forbidden", "Only the assignee or a maintainer may upload this bundle");
      const checks = safeJson(row.local_checks_json);
      if (!Array.isArray(checks) || checks.length === 0 || checks.some((item) => typeof item !== "object" || item === null || (item as Record<string, unknown>).passed !== true)) throw new DomainError("state_conflict", "All declared local checks must pass before bundle upload");
      if (typeof row.agent_report !== "string" || !row.agent_report.trim()) throw new DomainError("state_conflict", "A local Agent validation report is required before bundle upload");
      const bytes = await readRawBody(request, 50 * 1024 * 1024);
      const digest = createHash("sha256").update(bytes).digest("hex");
      const bundleDirectory = joinPath(config.dataDirectory, "bundles");
      await mkdir(bundleDirectory, { recursive: true });
      const bundlePath = joinPath(bundleDirectory, `${submissionId}.bundle`);
      await writeFile(bundlePath, bytes, { mode: 0o600 });
      try {
        await importSubmissionBundle({ bareRepoPath, bundlePath, submissionId, baseCommit: String(row.base_commit), headCommit: String(row.head_commit), maxBytes: 50 * 1024 * 1024 });
        database.prepare("UPDATE submission_evidence SET bundle_digest=?,bundle_size=?,bundle_status='imported',updated_at=? WHERE submission_id=?").run(digest, bytes.length, new Date().toISOString(), submissionId);
        const enqueued = mergeQueue.enqueueSubmission({ deviceId: identity.session.deviceId, idempotencyKey: `bundle-enqueue-${submissionId}`.slice(0, 128), projectId, submissionId, headCommit: String(row.head_commit), baseCommit: String(row.base_commit), targetBranch: config.targetBranch ?? "main", actorId: identity.user.id });
        const processed = await mergeQueue.processEntry(enqueued.value.id);
        return writeJson(response, 201, { digest, size: bytes.length, entry: enqueued.value, result: processed });
      } catch (error) {
        database.prepare("UPDATE submission_evidence SET bundle_digest=?,bundle_size=?,bundle_status='failed',updated_at=? WHERE submission_id=?").run(digest, bytes.length, new Date().toISOString(), submissionId);
        await rm(bundlePath, { force: true });
        throw error;
      }
    }
    const agentReviewMatch = projectId && projectMatch?.[2]?.match(/^\/merge-queue\/([^/]+)\/agent-review$/);
    if (agentReviewMatch && request.method === "POST") {
      requireProjectRole(database, projectId, identity.user.id, "maintainer");
      const body = await readBody(request);
      if (body.verdict !== "approve" && body.verdict !== "reject") throw new DomainError("validation_failed", "Agent verdict must be approve or reject");
      const report = string(body.report, "report");
      if (report.length > 100000) throw new DomainError("validation_failed", "Agent review report is too large");
      const entryId = decodeSegment(agentReviewMatch[1]!);
      const result = database.prepare("UPDATE merge_queue_entries SET agent_review=?,agent_verdict=?,agent_reviewed_at=?,updated_at=? WHERE id=? AND project_id=? AND status='reviewing'").run(report, body.verdict, new Date().toISOString(), new Date().toISOString(), entryId, projectId);
      if (Number(result.changes) !== 1) throw new DomainError("state_conflict", "Merge entry is not awaiting review");
      return writeJson(response, 200, { entryId, verdict: body.verdict, report });
    }
    const queueReviewMatch = projectId && projectMatch?.[2]?.match(/^\/merge-queue\/([^/]+)\/review$/);
    if (queueReviewMatch && request.method === "POST") {
      if (!mergeQueue) throw new DomainError("state_conflict", "Host integration repository is not configured");
      requireProjectRole(database, projectId, identity.user.id, "maintainer");
      const body = await readBody(request);
      if (body.verdict !== "approve" && body.verdict !== "reject") throw new DomainError("validation_failed", "Review verdict must be approve or reject");
      const entryId = decodeSegment(queueReviewMatch[1]!);
      const reviewState = database.prepare("SELECT agent_verdict FROM merge_queue_entries WHERE id=? AND project_id=?").get(entryId, projectId);
      if (!reviewState) throw new DomainError("not_found", "Merge queue entry not found");
      if (body.verdict === "approve" && reviewState.agent_verdict !== "approve") throw new DomainError("state_conflict", "Host Agent must approve before human merge approval");
      const result = await mergeQueue.reviewEntry({ deviceId: identity.session.deviceId, idempotencyKey: idempotency(request, body), entryId, actorId: identity.user.id, verdict: body.verdict });
      return writeJson(response, 200, result);
    }
    throw new DomainError("not_found", "Route not found");
  }

  async function join(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readBody(request);
    if (body.joinToken !== config.joinToken) throw new DomainError("unauthenticated", "Invalid team join token");
    const projectId = string(body.projectId, "projectId");
    const displayName = string(body.displayName ?? body.userId, "displayName");
    const deviceName = string(body.deviceName ?? body.deviceId, "deviceName");
    const userId = `user_${randomUUID()}`;
    const deviceId = `device_${randomUUID()}`;
    const now = new Date().toISOString();
    database.exec("BEGIN IMMEDIATE");
    try {
      if (!database.prepare("SELECT id FROM projects WHERE id=?").get(projectId)) database.prepare("INSERT INTO projects(id,name,created_at) VALUES (?,?,?)").run(projectId, typeof body.projectName === "string" ? body.projectName : projectId, now);
      database.prepare("INSERT INTO users(id,display_name,email,created_at) VALUES (?,?,?,?)").run(userId, displayName, null, now);
      database.prepare("INSERT INTO devices(id,user_id,device_name,public_key_fingerprint,last_seen_at,status,created_at) VALUES (?,?,?,?,?,?,?)").run(deviceId, userId, deviceName, null, now, "active", now);
      const memberCount = Number(database.prepare("SELECT COUNT(*) AS n FROM memberships WHERE project_id=?").get(projectId)?.n ?? 0);
      if (!database.prepare("SELECT role FROM memberships WHERE project_id=? AND user_id=?").get(projectId, userId)) database.prepare("INSERT INTO memberships(project_id,user_id,role,created_at) VALUES (?,?,?,?)").run(projectId, userId, memberCount === 0 ? "owner" : "contributor", now);
      const roomId = `room_${projectId}`;
      if (!database.prepare("SELECT id FROM rooms WHERE id=?").get(roomId)) database.prepare("INSERT INTO rooms(id,project_id,name,created_at,archived_at) VALUES (?,?,?,?,?)").run(roomId, projectId, "general", now, null);
      const sessionId = randomUUID();
      const expiresAt = new Date(Date.now() + 30 * 86400000).toISOString();
      const resumeToken = randomBytes(32).toString("base64url");
      database.prepare("INSERT INTO sessions(id,user_id,device_id,issued_at,expires_at,revoked_at) VALUES (?,?,?,?,?,?)").run(sessionId, userId, deviceId, now, expiresAt, null);
      database.prepare("INSERT INTO device_resume_credentials(device_id,user_id,secret_digest,created_at,last_used_at,revoked_at) VALUES (?,?,?,?,?,NULL)").run(deviceId, userId, credentialDigest(resumeToken), now, now);
      database.exec("COMMIT");
      return writeJson(response, 201, { session: { id: sessionId, issuedAt: now, expiresAt }, resumeToken, projectId, userId, deviceId, role: memberCount === 0 ? "owner" : "contributor" });
    } catch (error) { database.exec("ROLLBACK"); throw error; }
  }

  async function resume(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readBody(request);
    const projectId = string(body.projectId, "projectId");
    const deviceId = string(body.deviceId, "deviceId");
    const resumeToken = string(body.resumeToken, "resumeToken");
    const credential = database.prepare("SELECT user_id,revoked_at FROM device_resume_credentials WHERE device_id=? AND secret_digest=?").get(deviceId, credentialDigest(resumeToken));
    if (!credential || credential.revoked_at !== null) throw new DomainError("unauthenticated", "Device resume credential is invalid or revoked");
    const membership = database.prepare("SELECT role FROM memberships WHERE project_id=? AND user_id=?").get(projectId, credential.user_id);
    if (!membership) throw new DomainError("forbidden", "Device user is no longer a project member");
    const now = new Date().toISOString(); const sessionId = randomUUID(); const expiresAt = new Date(Date.now() + 30 * 86400000).toISOString();
    database.exec("BEGIN IMMEDIATE");
    try {
      database.prepare("INSERT INTO sessions(id,user_id,device_id,issued_at,expires_at,revoked_at) VALUES (?,?,?,?,?,NULL)").run(sessionId, credential.user_id, deviceId, now, expiresAt);
      database.prepare("UPDATE device_resume_credentials SET last_used_at=? WHERE device_id=?").run(now, deviceId);
      database.prepare("UPDATE devices SET last_seen_at=?,status='active' WHERE id=?").run(now, deviceId);
      database.exec("COMMIT");
    } catch (error) { database.exec("ROLLBACK"); throw error; }
    return writeJson(response, 201, { session: { id: sessionId, issuedAt: now, expiresAt }, projectId, userId: String(credential.user_id), deviceId, role: membership.role });
  }

  function authenticate(request: IncomingMessage) {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw new DomainError("unauthenticated", "Bearer session is required");
    const identity = resolveActiveSession(database, header.slice(7));
    database.prepare("UPDATE devices SET last_seen_at=? WHERE id=?").run(new Date().toISOString(), identity.device.id);
    return identity;
  }
}

function credentialDigest(token: string): string { return createHash("sha256").update(token, "utf8").digest("hex"); }

async function readBody(request: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 1_048_576) throw new DomainError("request_too_large", "Request body exceeds 1 MiB"); chunks.push(bytes); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Json; } catch { throw new DomainError("validation_failed", "Request body must be JSON"); }
}
async function readRawBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > maxBytes) throw new DomainError("request_too_large", `Request body exceeds ${maxBytes} bytes`);
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}
function headerString(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  if (typeof value !== "string" || !value.trim()) throw new DomainError("validation_failed", `${name} header is required`);
  let decoded: string;
  try { decoded = decodeURIComponent(value.trim()); } catch { throw new DomainError("validation_failed", `${name} header is not valid URI-encoded text`); }
  if (!decoded || decoded.length > 256 || decoded.includes("\0")) throw new DomainError("validation_failed", `${name} header is invalid`);
  return decoded;
}
function mutationContext(request: IncomingMessage, route: string, projectId: string, actorId: string, deviceId: string, body: Json) {
  return { projectId, actorId, deviceId, route, idempotencyKey: idempotency(request, body) };
}
function string(value: unknown, field: string): string { if (typeof value !== "string" || !value.trim()) throw new DomainError("validation_failed", `${field} is required`); return value.trim(); }
function number(value: unknown, fallback: number): number { const n = value === undefined ? fallback : Number(value); if (!Number.isInteger(n) || n < 1) throw new DomainError("validation_failed", "Expected a positive integer"); return n; }
function strings(value: unknown, field: string, required = false): string[] { if (value === undefined && !required) return []; if (!Array.isArray(value) || (required && value.length === 0) || value.some((item) => typeof item !== "string" || !item.trim())) throw new DomainError("validation_failed", `${field} must be${required ? " a non-empty" : " an"} array of strings`); return value.map((item) => (item as string).trim()); }
function jsonStrings(value: unknown): string[] { try { const parsed = JSON.parse(String(value)) as unknown; return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []; } catch { return []; } }
function validateOwnershipScopes(scopes: string[]): void { for (const scope of scopes) { const base = scope.replace(/\/(\*\*|\*)$/, ""); if (!base || base.startsWith("/") || base.includes("\\") || base.split("/").includes("..") || !/^[A-Za-z0-9._/-]+$/.test(base)) throw new DomainError("validation_failed", `Invalid ownership scope '${scope}'`); } }
function validateAcceptanceChecks(checks: string[]): void { const allowed = new Set(["pnpm", "npm", "yarn", "node", "git", "cargo", "go"]); for (const check of checks) { if (/[;&|`$<>\n\r]/.test(check) || !allowed.has(check.trim().split(/\s+/, 1)[0]!)) throw new DomainError("validation_failed", `Unsafe acceptance check '${check}'`); } }
function safeJson(value: unknown): unknown { if (value === null || value === undefined) return null; try { return JSON.parse(String(value)) as unknown; } catch { return value; } }
function toTask(row: Record<string, unknown>): Json { return { id: row.id, taskId: row.task_id, title: row.title, description: row.description ?? "", baselineId: row.baseline_id ?? null, requirementIds: jsonStrings(row.requirement_ids_json), status: row.status, version: row.version, policy: { parallel: row.parallel === 1, locks: jsonStrings(row.locks_json), ownershipScopes: jsonStrings(row.ownership_scopes_json), acceptanceChecks: jsonStrings(row.acceptance_checks_json), reviewers: jsonStrings(row.reviewers_json) } }; }
function decodeSegment(value: string): string { try { const decoded = decodeURIComponent(value); if (!decoded || decoded.includes("/") || decoded.includes("\\")) throw new Error(); return decoded; } catch { throw new DomainError("validation_failed", "Invalid path segment"); } }
function idempotency(request: IncomingMessage, body: Json): string { const value = request.headers["idempotency-key"] ?? body.idempotencyKey; return typeof value === "string" && value.length >= 16 ? value : randomUUID(); }
function writeJson(response: ServerResponse, status: number, body: unknown): void { response.writeHead(status, { "content-type": "application/json; charset=utf-8" }); response.end(JSON.stringify(body)); }
function writeError(response: ServerResponse, request: IncomingMessage, error: unknown): void {
  const requestId = typeof request.headers["x-request-id"] === "string" ? request.headers["x-request-id"] : randomUUID();
  const code = error instanceof DomainError || error instanceof WorkError || error instanceof MergeQueueError ? error.code : "internal_error";
  const status: Record<string, number> = { unauthenticated: 401, forbidden: 403, not_found: 404, state_conflict: 409, version_conflict: 409, request_too_large: 413, validation_failed: 422, bundle_invalid: 422, path_violation: 422, check_failed: 422, conflict: 409, stale_target: 409 };
  const expected = error instanceof DomainError || error instanceof WorkError || error instanceof MergeQueueError;
  writeJson(response, status[code] ?? 500, { error: { code, message: expected ? error.message : "Internal server error", requestId, retryable: false, details: expected ? error.details : undefined } });
}
