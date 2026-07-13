import { randomUUID } from "node:crypto";
import { requireProjectRole } from "../identity/authorization.js";
import { DomainError } from "../identity/errors.js";
import type { SqliteDatabase } from "../sqlite.js";
import { executeIdempotent } from "../store.js";
import type {
  BaselineApproval,
  BaselineCitation,
  ConsensusBaseline,
  CoordinationSnapshot,
  MemberAgentProfile,
  SubmissionEvidence,
  TaskPreference,
  WorkflowPhase
} from "./types.js";

type MutationContext = { projectId: string; actorId: string; deviceId: string; idempotencyKey: string; route: string };

function parseStringArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value)) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseCitations(value: unknown): BaselineCitation[] {
  try {
    const parsed = JSON.parse(String(value)) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is BaselineCitation => typeof item === "object" && item !== null && ((item as BaselineCitation).kind === "message" || (item as BaselineCitation).kind === "attachment") && typeof (item as BaselineCitation).id === "string");
  } catch {
    return [];
  }
}

function mapBaseline(row: Record<string, unknown>): ConsensusBaseline {
  return {
    id: String(row.id), projectId: String(row.project_id), revision: Number(row.revision), status: String(row.status) as ConsensusBaseline["status"],
    title: String(row.title), summary: String(row.summary), requirements: parseStringArray(row.requirements_json), constraints: parseStringArray(row.constraints_json),
    decisions: parseStringArray(row.decisions_json), acceptanceCriteria: parseStringArray(row.acceptance_criteria_json), risks: parseStringArray(row.risks_json),
    openQuestions: parseStringArray(row.open_questions_json), citations: parseCitations(row.citations_json), createdByUserId: String(row.created_by_user_id),
    createdAt: String(row.created_at), frozenAt: row.frozen_at === null ? null : String(row.frozen_at)
  };
}

function ensureCoordination(database: SqliteDatabase, projectId: string): void {
  if (!database.prepare("SELECT id FROM projects WHERE id=?").get(projectId)) throw new DomainError("not_found", "Project not found");
  database.prepare("INSERT OR IGNORE INTO project_coordination(project_id,phase,active_baseline_id,version,updated_at) VALUES (?,?,?,?,?)")
    .run(projectId, "planning", null, 1, new Date().toISOString());
}

function validateStringList(value: unknown, label: string, max = 200): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim().length > 0 && item.length <= 4000) || value.length > max) {
    throw new DomainError("validation_failed", `${label} must be an array of non-empty strings`);
  }
  return value.map((item) => item.trim());
}

function validateCitations(database: SqliteDatabase, projectId: string, citations: BaselineCitation[]): void {
  for (const citation of citations) {
    if (citation.kind === "message") {
      const found = database.prepare("SELECT m.id FROM messages m JOIN rooms r ON r.id=m.room_id WHERE m.id=? AND r.project_id=?").get(citation.id, projectId);
      if (!found) throw new DomainError("validation_failed", `Message citation '${citation.id}' is not part of this project`);
    } else {
      const found = database.prepare("SELECT id FROM attachments WHERE id=? AND project_id=? AND status='ready'").get(citation.id, projectId);
      if (!found) throw new DomainError("validation_failed", `Attachment citation '${citation.id}' is not ready in this project`);
    }
  }
}

export function getCoordinationSnapshot(database: SqliteDatabase, projectId: string): CoordinationSnapshot {
  ensureCoordination(database, projectId);
  const state = database.prepare("SELECT phase,active_baseline_id,version FROM project_coordination WHERE project_id=?").get(projectId)!;
  const baselines = database.prepare("SELECT * FROM consensus_baselines WHERE project_id=? ORDER BY revision DESC").all(projectId).map(mapBaseline);
  const approvals = database.prepare("SELECT a.* FROM baseline_approvals a JOIN consensus_baselines b ON b.id=a.baseline_id WHERE b.project_id=? ORDER BY a.created_at").all(projectId).map((row) => ({ baselineId: String(row.baseline_id), userId: String(row.user_id), decision: String(row.decision) as BaselineApproval["decision"], reason: row.reason === null ? null : String(row.reason), createdAt: String(row.created_at) }));
  const preferences = database.prepare("SELECT * FROM task_preferences WHERE project_id=? ORDER BY created_at").all(projectId).map((row) => ({ projectId: String(row.project_id), taskId: String(row.task_id), userId: String(row.user_id), note: String(row.note), createdAt: String(row.created_at) } satisfies TaskPreference));
  const agentProfiles = database.prepare("SELECT * FROM member_agent_profiles WHERE project_id=? ORDER BY updated_at DESC").all(projectId).map((row) => ({ projectId: String(row.project_id), userId: String(row.user_id), deviceId: String(row.device_id), kind: String(row.kind) as MemberAgentProfile["kind"], name: String(row.name), version: row.version === null ? null : String(row.version), capabilities: parseStringArray(row.capabilities_json), updatedAt: String(row.updated_at) } satisfies MemberAgentProfile));
  const submissionEvidence = database.prepare("SELECT * FROM submission_evidence WHERE project_id=? ORDER BY created_at DESC").all(projectId).map((row) => ({ submissionId: String(row.submission_id), projectId: String(row.project_id), submittedByUserId: String(row.submitted_by_user_id), localChecks: JSON.parse(String(row.local_checks_json)) as SubmissionEvidence["localChecks"], agentReport: row.agent_report === null ? null : String(row.agent_report), bundleDigest: row.bundle_digest === null ? null : String(row.bundle_digest), bundleSize: row.bundle_size === null ? null : Number(row.bundle_size), bundleStatus: String(row.bundle_status) as SubmissionEvidence["bundleStatus"], createdAt: String(row.created_at), updatedAt: String(row.updated_at) }));
  return { phase: String(state.phase) as WorkflowPhase, activeBaselineId: state.active_baseline_id === null ? null : String(state.active_baseline_id), version: Number(state.version), baselines, approvals, preferences, agentProfiles, submissionEvidence };
}

export function createConsensusBaseline(database: SqliteDatabase, context: MutationContext, input: Omit<ConsensusBaseline, "id" | "projectId" | "revision" | "status" | "createdByUserId" | "createdAt" | "frozenAt">): ConsensusBaseline {
  requireProjectRole(database, context.projectId, context.actorId, "contributor");
  ensureCoordination(database, context.projectId);
  if (!input.title.trim() || input.title.length > 256 || input.summary.length > 20000) throw new DomainError("validation_failed", "Baseline title or summary is invalid");
  const requirements = validateStringList(input.requirements, "requirements");
  const constraints = validateStringList(input.constraints, "constraints");
  const decisions = validateStringList(input.decisions, "decisions");
  const acceptanceCriteria = validateStringList(input.acceptanceCriteria, "acceptanceCriteria");
  const risks = validateStringList(input.risks, "risks");
  const openQuestions = validateStringList(input.openQuestions, "openQuestions");
  const citations = Array.isArray(input.citations) ? input.citations : [];
  validateCitations(database, context.projectId, citations);
  const result = executeIdempotent(database, { deviceId: context.deviceId, route: context.route, projectId: context.projectId, key: context.idempotencyKey, requestFingerprint: JSON.stringify(input), execute: (unit) => {
    const revision = Number(unit.database.prepare("SELECT COALESCE(MAX(revision),0)+1 AS n FROM consensus_baselines WHERE project_id=?").get(context.projectId)?.n ?? 1);
    const id = `base_${randomUUID()}`;
    const now = new Date().toISOString();
    unit.database.prepare("UPDATE consensus_baselines SET status='superseded' WHERE project_id=? AND status='draft'").run(context.projectId);
    unit.database.prepare("INSERT INTO consensus_baselines(id,project_id,revision,status,title,summary,requirements_json,constraints_json,decisions_json,acceptance_criteria_json,risks_json,open_questions_json,citations_json,created_by_user_id,created_at,frozen_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, context.projectId, revision, "draft", input.title.trim(), input.summary.trim(), JSON.stringify(requirements), JSON.stringify(constraints), JSON.stringify(decisions), JSON.stringify(acceptanceCriteria), JSON.stringify(risks), JSON.stringify(openQuestions), JSON.stringify(citations), context.actorId, now, null);
    unit.database.prepare("UPDATE project_coordination SET phase='consensus',version=version+1,updated_at=? WHERE project_id=?").run(now, context.projectId);
    unit.appendEvent({ projectId: context.projectId, aggregateType: "consensus_baseline", aggregateId: id, aggregateVersion: revision, type: "consensus.baseline_created" });
    unit.audit({ projectId: context.projectId, actorId: context.actorId, action: "consensus.baseline_create", aggregateType: "consensus_baseline", aggregateId: id, details: { revision } });
    return mapBaseline(unit.database.prepare("SELECT * FROM consensus_baselines WHERE id=?").get(id)!);
  }});
  return result.value;
}

export function decideConsensusBaseline(database: SqliteDatabase, context: MutationContext, baselineId: string, decision: "approve" | "reject", reason?: string): BaselineApproval {
  requireProjectRole(database, context.projectId, context.actorId, "contributor");
  const baseline = database.prepare("SELECT id,status FROM consensus_baselines WHERE id=? AND project_id=?").get(baselineId, context.projectId);
  if (!baseline) throw new DomainError("not_found", "Consensus baseline not found");
  if (baseline.status !== "draft") throw new DomainError("state_conflict", "Only a draft baseline can be approved or rejected");
  return executeIdempotent(database, { deviceId: context.deviceId, route: context.route, projectId: context.projectId, key: context.idempotencyKey, requestFingerprint: `${baselineId}:${decision}:${reason ?? ""}`, execute: (unit) => {
    const now = new Date().toISOString();
    unit.database.prepare("INSERT INTO baseline_approvals(baseline_id,user_id,decision,reason,created_at) VALUES (?,?,?,?,?) ON CONFLICT(baseline_id,user_id) DO UPDATE SET decision=excluded.decision,reason=excluded.reason,created_at=excluded.created_at")
      .run(baselineId, context.actorId, decision, reason?.trim() || null, now);
    unit.appendEvent({ projectId: context.projectId, aggregateType: "baseline_approval", aggregateId: `${baselineId}:${context.actorId}`, aggregateVersion: 1, type: `consensus.${decision === "approve" ? "approved" : "rejected"}` });
    unit.audit({ projectId: context.projectId, actorId: context.actorId, action: `consensus.${decision}`, aggregateType: "consensus_baseline", aggregateId: baselineId, details: { reason: reason ?? null } });
    return { baselineId, userId: context.actorId, decision, reason: reason?.trim() || null, createdAt: now };
  }}).value;
}

export function freezeConsensusBaseline(database: SqliteDatabase, context: MutationContext, baselineId: string): ConsensusBaseline {
  requireProjectRole(database, context.projectId, context.actorId, "maintainer");
  const baselineRow = database.prepare("SELECT * FROM consensus_baselines WHERE id=? AND project_id=?").get(baselineId, context.projectId);
  if (!baselineRow) throw new DomainError("not_found", "Consensus baseline not found");
  const baseline = mapBaseline(baselineRow);
  if (baseline.status !== "draft") throw new DomainError("state_conflict", "Only a draft baseline can be frozen");
  if (baseline.openQuestions.length > 0) throw new DomainError("state_conflict", "Resolve all open questions before freezing the baseline");
  const requiredMembers = database.prepare("SELECT user_id FROM memberships WHERE project_id=? AND role<>'viewer'").all(context.projectId).map((row) => String(row.user_id));
  const approvals = new Map(database.prepare("SELECT user_id,decision FROM baseline_approvals WHERE baseline_id=?").all(baselineId).map((row) => [String(row.user_id), String(row.decision)]));
  const missing = requiredMembers.filter((userId) => approvals.get(userId) !== "approve");
  if (missing.length > 0) throw new DomainError("state_conflict", `Every contributor must approve this revision before freeze: ${missing.join(", ")}`);
  return executeIdempotent(database, { deviceId: context.deviceId, route: context.route, projectId: context.projectId, key: context.idempotencyKey, requestFingerprint: baselineId, execute: (unit) => {
    const now = new Date().toISOString();
    unit.database.prepare("UPDATE consensus_baselines SET status='superseded' WHERE project_id=? AND status='frozen'").run(context.projectId);
    unit.database.prepare("UPDATE consensus_baselines SET status='frozen',frozen_at=? WHERE id=? AND status='draft'").run(now, baselineId);
    unit.database.prepare("UPDATE project_coordination SET phase='execution',active_baseline_id=?,version=version+1,updated_at=? WHERE project_id=?").run(baselineId, now, context.projectId);
    unit.appendEvent({ projectId: context.projectId, aggregateType: "consensus_baseline", aggregateId: baselineId, aggregateVersion: baseline.revision, type: "consensus.baseline_frozen" });
    unit.audit({ projectId: context.projectId, actorId: context.actorId, action: "consensus.freeze", aggregateType: "consensus_baseline", aggregateId: baselineId, details: { revision: baseline.revision } });
    return mapBaseline(unit.database.prepare("SELECT * FROM consensus_baselines WHERE id=?").get(baselineId)!);
  }}).value;
}

export function registerMemberAgent(database: SqliteDatabase, context: MutationContext, input: Omit<MemberAgentProfile, "projectId" | "userId" | "deviceId" | "updatedAt">): MemberAgentProfile {
  requireProjectRole(database, context.projectId, context.actorId, "contributor");
  if (!["codex", "claude-code", "opencode", "pi", "manual"].includes(input.kind) || !input.name.trim()) throw new DomainError("validation_failed", "Agent profile is invalid");
  const capabilities = validateStringList(input.capabilities, "capabilities", 50);
  return executeIdempotent(database, { deviceId: context.deviceId, route: context.route, projectId: context.projectId, key: context.idempotencyKey, requestFingerprint: JSON.stringify(input), execute: (unit) => {
    const now = new Date().toISOString();
    unit.database.prepare("INSERT INTO member_agent_profiles(project_id,user_id,device_id,kind,name,version,capabilities_json,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(project_id,user_id,device_id) DO UPDATE SET kind=excluded.kind,name=excluded.name,version=excluded.version,capabilities_json=excluded.capabilities_json,updated_at=excluded.updated_at")
      .run(context.projectId, context.actorId, context.deviceId, input.kind, input.name.trim(), input.version, JSON.stringify(capabilities), now);
    unit.appendEvent({ projectId: context.projectId, aggregateType: "member_agent", aggregateId: `${context.actorId}:${context.deviceId}`, aggregateVersion: 1, type: "member.agent_registered" });
    return { projectId: context.projectId, userId: context.actorId, deviceId: context.deviceId, kind: input.kind, name: input.name.trim(), version: input.version, capabilities, updatedAt: now };
  }}).value;
}

export function setTaskPreference(database: SqliteDatabase, context: MutationContext, taskId: string, note: string): TaskPreference {
  requireProjectRole(database, context.projectId, context.actorId, "contributor");
  if (!database.prepare("SELECT id FROM work_tasks WHERE project_id=? AND (id=? OR task_id=?)").get(context.projectId, taskId, taskId)) throw new DomainError("not_found", "Task not found");
  if (note.length > 2000) throw new DomainError("validation_failed", "Preference note is too long");
  return executeIdempotent(database, { deviceId: context.deviceId, route: context.route, projectId: context.projectId, key: context.idempotencyKey, requestFingerprint: `${taskId}:${note}`, execute: (unit) => {
    const now = new Date().toISOString();
    unit.database.prepare("INSERT INTO task_preferences(project_id,task_id,user_id,note,created_at) VALUES (?,?,?,?,?) ON CONFLICT(project_id,task_id,user_id) DO UPDATE SET note=excluded.note,created_at=excluded.created_at").run(context.projectId, taskId, context.actorId, note.trim(), now);
    unit.appendEvent({ projectId: context.projectId, aggregateType: "task_preference", aggregateId: `${taskId}:${context.actorId}`, aggregateVersion: 1, type: "task.preference_recorded" });
    return { projectId: context.projectId, taskId, userId: context.actorId, note: note.trim(), createdAt: now };
  }}).value;
}

export function recordSubmissionEvidence(database: SqliteDatabase, context: MutationContext, submissionId: string, input: { localChecks: SubmissionEvidence["localChecks"]; agentReport?: string | null }): SubmissionEvidence {
  requireProjectRole(database, context.projectId, context.actorId, "contributor");
  const submission = database.prepare("SELECT s.id,a.assignee_user_id FROM work_submissions s JOIN work_assignments a ON a.id=s.assignment_id WHERE s.id=? AND s.project_id=?").get(submissionId, context.projectId);
  if (!submission) throw new DomainError("not_found", "Submission not found");
  if (submission.assignee_user_id !== context.actorId) throw new DomainError("forbidden", "Only the assignment owner may attach submission evidence");
  if (!Array.isArray(input.localChecks) || input.localChecks.length > 100 || input.agentReport && input.agentReport.length > 100000) throw new DomainError("validation_failed", "Submission evidence is invalid or too large");
  return executeIdempotent(database, { deviceId: context.deviceId, route: context.route, projectId: context.projectId, key: context.idempotencyKey, requestFingerprint: JSON.stringify(input), execute: (unit) => {
    const now = new Date().toISOString();
    unit.database.prepare("INSERT INTO submission_evidence(submission_id,project_id,submitted_by_user_id,local_checks_json,agent_report,bundle_digest,bundle_size,bundle_status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(submission_id) DO UPDATE SET local_checks_json=excluded.local_checks_json,agent_report=excluded.agent_report,updated_at=excluded.updated_at")
      .run(submissionId, context.projectId, context.actorId, JSON.stringify(input.localChecks), input.agentReport ?? null, null, null, "missing", now, now);
    unit.appendEvent({ projectId: context.projectId, aggregateType: "submission_evidence", aggregateId: submissionId, aggregateVersion: 1, type: "submission.evidence_recorded" });
    return getCoordinationSnapshot(unit.database, context.projectId).submissionEvidence.find((item) => item.submissionId === submissionId)!;
  }}).value;
}
