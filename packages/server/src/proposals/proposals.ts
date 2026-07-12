import type { SqliteDatabase } from "../sqlite.js";
import { executeIdempotent, type IdempotentResult, type UnitOfWork } from "../store.js";
import { notFound, validationFailed, stateConflict, versionConflict, forbidden } from "../identity/errors.js";
import { requireProjectRole } from "../identity/authorization.js";
import type { Session } from "../identity/types.js";
import type { ApprovalPolicy, Citation, Proposal, ProposalRevision, ProposalStatus, ApprovalDecision } from "./types.js";
import { DEFAULT_APPROVAL_POLICY, isApprovalDecision, isCitation, isProposalStatus } from "./types.js";

export type ProposalService = { database: SqliteDatabase; policy: ApprovalPolicy };

export function createProposalService(input: { database: SqliteDatabase; policy?: Partial<ApprovalPolicy> }): ProposalService {
  const policy: ApprovalPolicy = { ...DEFAULT_APPROVAL_POLICY, ...input.policy };
  return { database: input.database, policy };
}

export type CreateProposalInput = {
  deviceId: string;
  route: string;
  key: string;
  requestFingerprint: string;
  projectId: string;
  title: string;
  body: string;
  citations?: Citation[];
};

export function createProposal(service: ProposalService, session: Session, input: CreateProposalInput): IdempotentResult<{ proposal: Proposal; revision: ProposalRevision }> {
  if (typeof input.title !== "string" || input.title.length === 0 || input.title.length > 256) throw validationFailed("title is required and must be at most 256 characters", { length: input.title.length });
  if (typeof input.body !== "string") throw validationFailed("body is required", {});
  const citations = input.citations ?? [];
  for (const c of citations) if (!isCitation(c)) throw validationFailed("citation is invalid", { citation: c });
  return executeIdempotent(service.database, {
    deviceId: input.deviceId,
    route: input.route,
    key: input.key,
    requestFingerprint: input.requestFingerprint,
    execute: (unit) => createInTransaction(unit, session, service, input, citations)
  });
}

function createInTransaction(unit: UnitOfWork, session: Session, service: ProposalService, input: CreateProposalInput, citations: Citation[]): { proposal: Proposal; revision: ProposalRevision } {
  const project = unit.database.prepare("SELECT id FROM projects WHERE id=?").get(input.projectId);
  if (!project) throw notFound("Project", input.projectId);
  requireProjectRole(unit.database, input.projectId, session.userId, "contributor");
  const id = newId("prop");
  const revisionId = newId("rev");
  const now = new Date().toISOString();
  unit.database.prepare("INSERT INTO proposals(id, project_id, title, body, status, current_revision_id, version, created_by_user_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(id, input.projectId, input.title, input.body, "draft", revisionId, 1, session.userId, now, now);
  unit.database.prepare("INSERT INTO proposal_revisions(id, proposal_id, revision_number, title, body, citations_json, created_by_user_id, created_at) VALUES (?,?,?,?,?,?,?,?)").run(revisionId, id, 1, input.title, input.body, JSON.stringify(citations), session.userId, now);
  const proposal: Proposal = { id, projectId: input.projectId, title: input.title, body: input.body, status: "draft", currentRevisionId: revisionId, version: 1, createdByUserId: session.userId, createdAt: now, updatedAt: now };
  const revision: ProposalRevision = { id: revisionId, proposalId: id, revisionNumber: 1, title: input.title, body: input.body, citations, createdByUserId: session.userId, createdAt: now };
  unit.audit({ projectId: input.projectId, actorId: session.userId, action: "proposal.create", aggregateType: "proposal", aggregateId: id, details: { title: input.title } });
  unit.appendEvent({ projectId: input.projectId, aggregateType: "proposal", aggregateId: id, aggregateVersion: 1, type: "proposal.created" });
  unit.appendEvent({ projectId: input.projectId, aggregateType: "proposal_revision", aggregateId: revisionId, aggregateVersion: 1, type: "proposal.revision_created" });
  return { proposal, revision };
}

export type AppendRevisionInput = {
  deviceId: string;
  route: string;
  key: string;
  requestFingerprint: string;
  proposalId: string;
  title: string;
  body: string;
  citations?: Citation[];
  expectedVersion: number;
};

export function appendRevision(service: ProposalService, session: Session, input: AppendRevisionInput): IdempotentResult<{ proposal: Proposal; revision: ProposalRevision }> {
  if (typeof input.title !== "string" || input.title.length === 0 || input.title.length > 256) throw validationFailed("title is required and must be at most 256 characters", { length: input.title.length });
  if (typeof input.body !== "string") throw validationFailed("body is required", {});
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) throw validationFailed("expectedVersion must be a positive integer", { expectedVersion: input.expectedVersion });
  const citations = input.citations ?? [];
  for (const c of citations) if (!isCitation(c)) throw validationFailed("citation is invalid", { citation: c });
  return executeIdempotent(service.database, {
    deviceId: input.deviceId,
    route: input.route,
    key: input.key,
    requestFingerprint: input.requestFingerprint,
    execute: (unit) => appendRevisionInTransaction(unit, session, service, input, citations)
  });
}

function appendRevisionInTransaction(unit: UnitOfWork, session: Session, service: ProposalService, input: AppendRevisionInput, citations: Citation[]): { proposal: Proposal; revision: ProposalRevision } {
  const row = unit.database.prepare("SELECT id, project_id, title, body, status, current_revision_id, version, created_by_user_id, created_at, updated_at FROM proposals WHERE id=?").get(input.proposalId);
  if (!row) throw notFound("Proposal", input.proposalId);
  const current = rowToProposal(row);
  requireProjectRole(unit.database, current.projectId, session.userId, "contributor");
  if (current.version !== input.expectedVersion) throw versionConflict("proposal", current.id, current.version, input.expectedVersion);
  if (current.status === "withdrawn") throw stateConflict("Cannot append revision to a withdrawn proposal", { proposalId: current.id });
  const lastNumberRow = unit.database.prepare("SELECT COALESCE(MAX(revision_number), 0) AS n FROM proposal_revisions WHERE proposal_id=?").get(current.id);
  const nextNumber = Number(lastNumberRow?.n ?? 0) + 1;
  const revisionId = newId("rev");
  const now = new Date().toISOString();
  unit.database.prepare("INSERT INTO proposal_revisions(id, proposal_id, revision_number, title, body, citations_json, created_by_user_id, created_at) VALUES (?,?,?,?,?,?,?,?)").run(revisionId, current.id, nextNumber, input.title, input.body, JSON.stringify(citations), session.userId, now);
  const newVersion = current.version + 1;
  unit.database.prepare("UPDATE proposals SET current_revision_id=?, title=?, body=?, version=?, updated_at=? WHERE id=?").run(revisionId, input.title, input.body, newVersion, now, current.id);
  const updatedRow = unit.database.prepare("SELECT id, project_id, title, body, status, current_revision_id, version, created_by_user_id, created_at, updated_at FROM proposals WHERE id=?").get(current.id)!;
  const proposal = rowToProposal(updatedRow);
  const revision: ProposalRevision = { id: revisionId, proposalId: current.id, revisionNumber: nextNumber, title: input.title, body: input.body, citations, createdByUserId: session.userId, createdAt: now };
  unit.audit({ projectId: current.projectId, actorId: session.userId, action: "proposal.append_revision", aggregateType: "proposal", aggregateId: current.id, details: { revisionNumber: nextNumber, previousRevisionId: current.currentRevisionId } });
  unit.appendEvent({ projectId: current.projectId, aggregateType: "proposal", aggregateId: current.id, aggregateVersion: newVersion, type: "proposal.revision_appended" });
  unit.appendEvent({ projectId: current.projectId, aggregateType: "proposal_revision", aggregateId: revisionId, aggregateVersion: 1, type: "proposal.revision_created" });
  return { proposal, revision };
}

export type TransitionProposalInput = {
  deviceId: string;
  route: string;
  key: string;
  requestFingerprint: string;
  proposalId: string;
  nextStatus: ProposalStatus;
  expectedVersion: number;
  reason?: string;
};

export function transitionProposal(service: ProposalService, session: Session, input: TransitionProposalInput): IdempotentResult<{ proposal: Proposal }> {
  if (!isProposalStatus(input.nextStatus)) throw validationFailed("nextStatus is invalid", { nextStatus: input.nextStatus });
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) throw validationFailed("expectedVersion must be a positive integer", { expectedVersion: input.expectedVersion });
  return executeIdempotent(service.database, {
    deviceId: input.deviceId,
    route: input.route,
    key: input.key,
    requestFingerprint: input.requestFingerprint,
    execute: (unit) => transitionInTransaction(unit, session, service, input)
  });
}

function transitionInTransaction(unit: UnitOfWork, session: Session, service: ProposalService, input: TransitionProposalInput): { proposal: Proposal } {
  const row = unit.database.prepare("SELECT id, project_id, title, body, status, current_revision_id, version, created_by_user_id, created_at, updated_at FROM proposals WHERE id=?").get(input.proposalId);
  if (!row) throw notFound("Proposal", input.proposalId);
  const current = rowToProposal(row);
  if (current.version !== input.expectedVersion) throw versionConflict("proposal", current.id, current.version, input.expectedVersion);
  if (current.status === input.nextStatus) return { proposal: current };
  requireProjectRole(unit.database, current.projectId, session.userId, transitionMinimumRole(current.status, input.nextStatus));
  if (!isValidTransition(current.status, input.nextStatus)) throw stateConflict("Transition is not allowed", { from: current.status, to: input.nextStatus });
  if (input.nextStatus === "approved" || input.nextStatus === "rejected") {
    if (!current.currentRevisionId) throw stateConflict("Proposal has no current revision to evaluate", { proposalId: current.id });
    const approvals = unit.database.prepare("SELECT decision, approver_user_id FROM approvals WHERE revision_id=?").all(current.currentRevisionId) as Array<{ decision: string; approver_user_id: string }>;
    const qualifying = approvals.filter((a) => a.decision === (input.nextStatus === "approved" ? "approve" : "reject"));
    const qualifyingApprovers = new Set(qualifying.map((a) => a.approver_user_id));
    let qualifyingCount = 0;
    for (const userId of qualifyingApprovers) {
      const member = unit.database.prepare("SELECT role FROM memberships WHERE project_id=? AND user_id=?").get(current.projectId, userId) as { role: string } | undefined;
      if (!member) continue;
      if (meetsRequiredRole(member.role, service.policy.requiredRole)) qualifyingCount += 1;
    }
    if (qualifyingCount < service.policy.requiredCount) throw stateConflict(`Not enough qualifying approvals (${qualifyingCount} of ${service.policy.requiredCount} required at ${service.policy.requiredRole} tier)`, { qualifyingCount, requiredCount: service.policy.requiredCount, requiredRole: service.policy.requiredRole });
  }
  const now = new Date().toISOString();
  const newVersion = current.version + 1;
  unit.database.prepare("UPDATE proposals SET status=?, version=?, updated_at=? WHERE id=?").run(input.nextStatus, newVersion, now, current.id);
  const updatedRow = unit.database.prepare("SELECT id, project_id, title, body, status, current_revision_id, version, created_by_user_id, created_at, updated_at FROM proposals WHERE id=?").get(current.id)!;
  const proposal = rowToProposal(updatedRow);
  unit.audit({ projectId: current.projectId, actorId: session.userId, action: `proposal.${input.nextStatus}`, aggregateType: "proposal", aggregateId: current.id, details: { previousStatus: current.status, reason: input.reason ?? null } });
  unit.appendEvent({ projectId: current.projectId, aggregateType: "proposal", aggregateId: current.id, aggregateVersion: newVersion, type: `proposal.${input.nextStatus}` });
  return { proposal };
}

export type RecordApprovalInput = {
  deviceId: string;
  route: string;
  key: string;
  requestFingerprint: string;
  proposalId: string;
  revisionId: string;
  decision: ApprovalDecision;
  reason?: string;
};

export function recordApproval(service: ProposalService, session: Session, input: RecordApprovalInput): IdempotentResult<{ approval: { id: string; proposalId: string; revisionId: string; approverUserId: string; decision: ApprovalDecision; reason: string | null; createdAt: string } }> {
  if (!isApprovalDecision(input.decision)) throw validationFailed("decision must be 'approve' or 'reject'", { decision: input.decision });
  return executeIdempotent(service.database, {
    deviceId: input.deviceId,
    route: input.route,
    key: input.key,
    requestFingerprint: input.requestFingerprint,
    execute: (unit) => recordApprovalInTransaction(unit, session, service, input)
  });
}

function recordApprovalInTransaction(unit: UnitOfWork, session: Session, service: ProposalService, input: RecordApprovalInput) {
  const proposalRow = unit.database.prepare("SELECT id, project_id, current_revision_id, status FROM proposals WHERE id=?").get(input.proposalId);
  if (!proposalRow) throw notFound("Proposal", input.proposalId);
  const revisionRow = unit.database.prepare("SELECT id, proposal_id, revision_number FROM proposal_revisions WHERE id=?").get(input.revisionId);
  if (!revisionRow) throw notFound("Proposal revision", input.revisionId);
  if (revisionRow.proposal_id !== input.proposalId) throw validationFailed("Revision does not belong to proposal", { proposalId: input.proposalId, revisionId: input.revisionId });
  if (proposalRow.current_revision_id !== input.revisionId) throw stateConflict("Approval can only be recorded for the current revision", { currentRevisionId: proposalRow.current_revision_id, requestedRevisionId: input.revisionId });
  const role = requireProjectRole(unit.database, String(proposalRow.project_id), session.userId, service.policy.requiredRole);
  void role;
  const id = newId("appr");
  const now = new Date().toISOString();
  try {
    unit.database.prepare("INSERT INTO approvals(id, proposal_id, revision_id, approver_user_id, decision, reason, created_at) VALUES (?,?,?,?,?,?,?)").run(id, input.proposalId, input.revisionId, session.userId, input.decision, input.reason ?? null, now);
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE")) {
      const existing = unit.database.prepare("SELECT id, proposal_id, revision_id, approver_user_id, decision, reason, created_at FROM approvals WHERE revision_id=? AND approver_user_id=?").get(input.revisionId, session.userId);
      if (existing) return { approval: rowToApproval(existing) };
      throw stateConflict("Approval already exists for this revision and approver", { revisionId: input.revisionId, approverUserId: session.userId });
    }
    throw error;
  }
  unit.audit({ projectId: String(proposalRow.project_id), actorId: session.userId, action: "approval.record", aggregateType: "approval", aggregateId: id, details: { proposalId: input.proposalId, revisionId: input.revisionId, decision: input.decision } });
  unit.appendEvent({ projectId: String(proposalRow.project_id), aggregateType: "approval", aggregateId: id, aggregateVersion: 1, type: `approval.${input.decision === "approve" ? "approved" : "rejected"}` });
  return { approval: { id, proposalId: input.proposalId, revisionId: input.revisionId, approverUserId: session.userId, decision: input.decision, reason: input.reason ?? null, createdAt: now } };
}

export function getProposal(database: SqliteDatabase, id: string): Proposal {
  const row = database.prepare("SELECT id, project_id, title, body, status, current_revision_id, version, created_by_user_id, created_at, updated_at FROM proposals WHERE id=?").get(id);
  if (!row) throw notFound("Proposal", id);
  return rowToProposal(row);
}

export function getRevision(database: SqliteDatabase, id: string): ProposalRevision {
  const row = database.prepare("SELECT id, proposal_id, revision_number, title, body, citations_json, created_by_user_id, created_at FROM proposal_revisions WHERE id=?").get(id);
  if (!row) throw notFound("Proposal revision", id);
  return rowToRevision(row);
}

export function listRevisions(database: SqliteDatabase, proposalId: string): ProposalRevision[] {
  return database.prepare("SELECT id, proposal_id, revision_number, title, body, citations_json, created_by_user_id, created_at FROM proposal_revisions WHERE proposal_id=? ORDER BY revision_number ASC").all(proposalId).map(rowToRevision);
}

export function listApprovalsForRevision(database: SqliteDatabase, revisionId: string): Array<{ id: string; proposalId: string; revisionId: string; approverUserId: string; decision: ApprovalDecision; reason: string | null; createdAt: string }> {
  return database.prepare("SELECT id, proposal_id, revision_id, approver_user_id, decision, reason, created_at FROM approvals WHERE revision_id=? ORDER BY created_at ASC").all(revisionId).map(rowToApproval);
}

function rowToProposal(row: Record<string, unknown>): Proposal {
  const status = String(row.status);
  if (!isProposalStatus(status)) throw validationFailed("Stored proposal status is invalid", { status });
  return { id: String(row.id), projectId: String(row.project_id), title: String(row.title), body: String(row.body), status, currentRevisionId: row.current_revision_id === null ? null : String(row.current_revision_id), version: Number(row.version), createdByUserId: String(row.created_by_user_id), createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}

function rowToRevision(row: Record<string, unknown>): ProposalRevision {
  let citations: Citation[] = [];
  try { const parsed = JSON.parse(String(row.citations_json)); if (Array.isArray(parsed)) citations = parsed.filter(isCitation); } catch { citations = []; }
  return { id: String(row.id), proposalId: String(row.proposal_id), revisionNumber: Number(row.revision_number), title: String(row.title), body: String(row.body), citations, createdByUserId: String(row.created_by_user_id), createdAt: String(row.created_at) };
}

function rowToApproval(row: Record<string, unknown>) {
  const decision = String(row.decision);
  if (!isApprovalDecision(decision)) throw validationFailed("Stored approval decision is invalid", { decision });
  return { id: String(row.id), proposalId: String(row.proposal_id), revisionId: String(row.revision_id), approverUserId: String(row.approver_user_id), decision, reason: row.reason === null ? null : String(row.reason), createdAt: String(row.created_at) };
}

function transitionMinimumRole(from: ProposalStatus, to: ProposalStatus): "contributor" | "maintainer" | "owner" {
  if (to === "withdrawn") return "maintainer";
  if (from === "draft" && to === "open") return "contributor";
  return "maintainer";
}

function isValidTransition(from: ProposalStatus, to: ProposalStatus): boolean {
  if (from === to) return true;
  if (from === "draft") return to === "open" || to === "withdrawn";
  if (from === "open") return to === "approved" || to === "rejected" || to === "withdrawn" || to === "draft";
  if (from === "approved" || from === "rejected") return to === "withdrawn" || to === "draft";
  return false;
}

function meetsRequiredRole(actual: string, minimum: "maintainer" | "owner"): boolean {
  const rank: Record<string, number> = { viewer: 1, contributor: 2, maintainer: 3, owner: 4 };
  return (rank[actual] ?? 0) >= (rank[minimum] ?? 0);
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}
