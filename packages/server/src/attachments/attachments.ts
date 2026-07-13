import type { SqliteDatabase } from "../sqlite.js";
import { executeIdempotent, type IdempotentResult, type UnitOfWork } from "../store.js";
import { notFound, requestTooLarge, validationFailed, stateConflict, forbidden, DomainError } from "../identity/errors.js";
import { requireProjectRole } from "../identity/authorization.js";
import type { Session } from "../identity/types.js";
import type { Attachment, AttachmentPolicy } from "./types.js";
import { DEFAULT_ATTACHMENT_POLICY } from "./types.js";
import { BlobStore } from "./blobs.js";

export type AttachmentService = { database: SqliteDatabase; policy: AttachmentPolicy; blobStore: BlobStore };

export function createAttachmentService(input: { database: SqliteDatabase; dataDirectory: string; policy?: Partial<AttachmentPolicy> }): AttachmentService {
  const policy: AttachmentPolicy = { maxSizeBytes: input.policy?.maxSizeBytes ?? DEFAULT_ATTACHMENT_POLICY.maxSizeBytes };
  const blobStore = new BlobStore(input.dataDirectory);
  blobStore.ensureDirectories();
  return { database: input.database, policy, blobStore };
}

export type StartAttachmentInput = {
  deviceId: string;
  route: string;
  key: string;
  requestFingerprint: string;
  projectId: string;
  declaredSize: number;
  declaredDigest: string;
  originalName: string;
  mediaType: string;
};

export function startAttachment(service: AttachmentService, session: Session, input: StartAttachmentInput): IdempotentResult<{ attachment: Attachment; stagedPath: string }> {
  if (!Number.isInteger(input.declaredSize) || input.declaredSize < 1) throw validationFailed("declaredSize must be a positive integer", { declaredSize: input.declaredSize });
  if (input.declaredSize > service.policy.maxSizeBytes) throw requestTooLarge(`declaredSize ${input.declaredSize} exceeds policy limit ${service.policy.maxSizeBytes}`, { declaredSize: input.declaredSize, maxSizeBytes: service.policy.maxSizeBytes });
  if (!isHexDigest(input.declaredDigest)) throw validationFailed("declaredDigest must be a hex-encoded SHA-256 digest", { declaredDigest: input.declaredDigest });
  if (typeof input.originalName !== "string" || input.originalName.length === 0 || input.originalName.length > 256) throw validationFailed("originalName is required and must be at most 256 characters", { originalNameLength: input.originalName.length });
  if (typeof input.mediaType !== "string" || input.mediaType.length === 0 || input.mediaType.length > 256) throw validationFailed("mediaType is required and must be at most 256 characters", {});
  return executeIdempotent(service.database, {
    deviceId: input.deviceId,
    route: input.route,
    key: input.key,
    requestFingerprint: input.requestFingerprint,
    execute: (unit) => startInTransaction(unit, session, service, input)
  });
}

function startInTransaction(unit: UnitOfWork, session: Session, service: AttachmentService, input: StartAttachmentInput): { attachment: Attachment; stagedPath: string } {
  const project = unit.database.prepare("SELECT id FROM projects WHERE id=?").get(input.projectId);
  if (!project) throw notFound("Project", input.projectId);
  requireProjectRole(unit.database, input.projectId, session.userId, "contributor");
  const id = newId("att");
  const now = new Date().toISOString();
  const stagedPath = service.blobStore.stagedPathFor(id);
  unit.database.prepare("INSERT INTO attachments(id, project_id, uploader_user_id, declared_size, declared_digest, actual_size, actual_digest, status, original_name, media_type, staged_path, created_at, promoted_at, supersedes_attachment_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id, input.projectId, session.userId, input.declaredSize, input.declaredDigest, null, null, "staged", input.originalName, input.mediaType, stagedPath, now, null, null);
  const attachment: Attachment = { id, projectId: input.projectId, uploaderUserId: session.userId, declaredSize: input.declaredSize, declaredDigest: input.declaredDigest, actualSize: null, actualDigest: null, status: "staged", originalName: input.originalName, mediaType: input.mediaType, stagedPath, createdAt: now, promotedAt: null, supersedesAttachmentId: null };
  unit.audit({ projectId: input.projectId, actorId: session.userId, action: "attachment.start", aggregateType: "attachment", aggregateId: id, details: { declaredSize: input.declaredSize, declaredDigest: input.declaredDigest, originalName: input.originalName } });
  unit.appendEvent({ projectId: input.projectId, aggregateType: "attachment", aggregateId: id, aggregateVersion: 1, type: "attachment.staged" });
  return { attachment, stagedPath };
}

export function writeStagedBytes(service: AttachmentService, session: Session, attachmentId: string, bytes: Buffer): { stagedPath: string } {
  const row = service.database.prepare("SELECT id, project_id, uploader_user_id, declared_size, declared_digest, actual_size, actual_digest, status, original_name, media_type, staged_path, created_at, promoted_at FROM attachments WHERE id=?").get(attachmentId);
  if (!row) throw notFound("Attachment", attachmentId);
  const attachment = rowToAttachment(row);
  assertAttachmentMutationAllowed(service.database, attachment, session);
  if (attachment.status !== "staged") throw stateConflict("Attachment is not in staged status", { attachmentId, status: attachment.status });
  if (bytes.length > service.policy.maxSizeBytes) throw requestTooLarge(`bytes exceed policy limit ${service.policy.maxSizeBytes}`, { size: bytes.length, maxSizeBytes: service.policy.maxSizeBytes });
  service.blobStore.writeStaged(attachment.stagedPath, bytes);
  return { stagedPath: attachment.stagedPath };
}

export type CompleteAttachmentInput = { deviceId: string; route: string; key: string; requestFingerprint: string; id: string };
export type CompleteAttachmentResult = { attachment: Attachment; deduplicated: boolean };

export function completeAttachment(service: AttachmentService, session: Session, input: CompleteAttachmentInput): IdempotentResult<CompleteAttachmentResult> {
  const result = executeIdempotent(service.database, {
    deviceId: input.deviceId,
    route: input.route,
    key: input.key,
    requestFingerprint: input.requestFingerprint,
    execute: (unit) => completeInTransaction(unit, session, service, input.id)
  });
  if ("failed" in result.value) {
    const failure = result.value;
    throw failure.error;
  }
  return { replayed: result.replayed, value: result.value };
}

type CompleteOutcome = CompleteAttachmentResult | { failed: true; error: DomainError };

function completeInTransaction(unit: UnitOfWork, session: Session, service: AttachmentService, id: string): CompleteOutcome {
  const row = unit.database.prepare("SELECT id, project_id, uploader_user_id, declared_size, declared_digest, actual_size, actual_digest, status, original_name, media_type, staged_path, created_at, promoted_at, supersedes_attachment_id FROM attachments WHERE id=?").get(id);
  if (!row) throw notFound("Attachment", id);
  const attachment = rowToAttachment(row);
  assertAttachmentMutationAllowed(unit.database, attachment, session);
  if (attachment.status === "ready") {
    return { attachment, deduplicated: false };
  }
  if (attachment.status === "superseded") {
    if (!attachment.supersedesAttachmentId) throw stateConflict("Superseded attachment has no original id", { attachmentId: attachment.id });
    const original = unit.database.prepare("SELECT id, project_id, uploader_user_id, declared_size, declared_digest, actual_size, actual_digest, status, original_name, media_type, staged_path, created_at, promoted_at, supersedes_attachment_id FROM attachments WHERE id=?").get(attachment.supersedesAttachmentId);
    if (!original) throw notFound("Original attachment for superseded record", attachment.supersedesAttachmentId);
    return { attachment: rowToAttachment(original), deduplicated: true };
  }
  if (attachment.status === "failed") throw stateConflict("Attachment previously failed digest verification", { attachmentId: attachment.id });
  if (!service.blobStore.exists(attachment.stagedPath)) {
    const error = validationFailed("Staged bytes are missing for attachment", { attachmentId: attachment.id, stagedPath: attachment.stagedPath });
    return { failed: true, error };
  }
  const { digest, size } = service.blobStore.readAndHash(attachment.stagedPath);
  if (digest !== attachment.declaredDigest) {
    const now = new Date().toISOString();
    unit.database.prepare("UPDATE attachments SET status='failed', actual_size=?, actual_digest=?, promoted_at=? WHERE id=?").run(size, digest, now, attachment.id);
    unit.audit({ projectId: attachment.projectId, actorId: session.userId, action: "attachment.complete", aggregateType: "attachment", aggregateId: attachment.id, details: { reason: "digest_mismatch", actualDigest: digest, declaredDigest: attachment.declaredDigest } });
    return { failed: true, error: validationFailed("Staged bytes do not match declaredDigest", { declaredDigest: attachment.declaredDigest, actualDigest: digest }) };
  }
  if (size !== attachment.declaredSize) {
    const now = new Date().toISOString();
    unit.database.prepare("UPDATE attachments SET status='failed', actual_size=?, actual_digest=?, promoted_at=? WHERE id=?").run(size, digest, now, attachment.id);
    unit.audit({ projectId: attachment.projectId, actorId: session.userId, action: "attachment.complete", aggregateType: "attachment", aggregateId: attachment.id, details: { reason: "size_mismatch", actualSize: size, declaredSize: attachment.declaredSize } });
    return { failed: true, error: validationFailed("Staged bytes do not match declaredSize", { declaredSize: attachment.declaredSize, actualSize: size }) };
  }
  const dedupe = unit.database.prepare("SELECT id, project_id, uploader_user_id, declared_size, declared_digest, actual_size, actual_digest, status, original_name, media_type, staged_path, created_at, promoted_at, supersedes_attachment_id FROM attachments WHERE project_id=? AND actual_digest=? AND status='ready' AND id<>? LIMIT 1").get(attachment.projectId, digest, attachment.id);
  if (dedupe) {
    const now = new Date().toISOString();
    unit.database.prepare("UPDATE attachments SET status='superseded', actual_size=?, actual_digest=?, promoted_at=?, supersedes_attachment_id=? WHERE id=?").run(size, digest, now, dedupe.id, attachment.id);
    unit.audit({ projectId: attachment.projectId, actorId: session.userId, action: "attachment.complete", aggregateType: "attachment", aggregateId: attachment.id, details: { reason: "deduped", duplicateOf: dedupe.id, digest } });
    unit.appendEvent({ projectId: attachment.projectId, aggregateType: "attachment", aggregateId: attachment.id, aggregateVersion: 2, type: "attachment.deduplicated" });
    service.blobStore.removeStaged(attachment.stagedPath);
    return { attachment: rowToAttachment(dedupe), deduplicated: true };
  }
  service.blobStore.ensureDirectories();
  service.blobStore.promote(attachment.stagedPath, digest);
  const now = new Date().toISOString();
  unit.database.prepare("UPDATE attachments SET status='ready', actual_size=?, actual_digest=?, promoted_at=? WHERE id=?").run(size, digest, now, attachment.id);
  unit.audit({ projectId: attachment.projectId, actorId: session.userId, action: "attachment.complete", aggregateType: "attachment", aggregateId: attachment.id, details: { size, digest } });
  unit.appendEvent({ projectId: attachment.projectId, aggregateType: "attachment", aggregateId: attachment.id, aggregateVersion: 2, type: "attachment.promoted" });
  return { attachment: { ...attachment, status: "ready", actualSize: size, actualDigest: digest, promotedAt: now, supersedesAttachmentId: null }, deduplicated: false };
}

export type ReadAttachmentResult = { attachment: Attachment; canonicalPath: string };

export function readAttachmentAuthorized(service: AttachmentService, session: Session, id: string): ReadAttachmentResult {
  const attachment = readAttachment(service, session, id);
  if (attachment.status !== "ready" || !attachment.actualDigest) throw stateConflict("Attachment is not ready to read", { attachmentId: id, status: attachment.status });
  const canonicalPath = service.blobStore.canonicalPathFor(attachment.actualDigest);
  if (!service.blobStore.exists(canonicalPath)) throw notFound("Attachment bytes", attachment.actualDigest);
  return { attachment, canonicalPath };
}

export function readAttachment(service: AttachmentService, session: Session, id: string): Attachment {
  const row = service.database.prepare("SELECT id, project_id, uploader_user_id, declared_size, declared_digest, actual_size, actual_digest, status, original_name, media_type, staged_path, created_at, promoted_at, supersedes_attachment_id FROM attachments WHERE id=?").get(id);
  if (!row) throw notFound("Attachment", id);
  const attachment = rowToAttachment(row);
  requireProjectRole(service.database, attachment.projectId, session.userId, "viewer");
  return attachment;
}

function rowToAttachment(row: Record<string, unknown>): Attachment {
  const status = String(row.status);
  if (status !== "staged" && status !== "ready" && status !== "failed" && status !== "superseded") throw validationFailed("Stored attachment status is invalid", { status });
  return { id: String(row.id), projectId: String(row.project_id), uploaderUserId: String(row.uploader_user_id), declaredSize: Number(row.declared_size), declaredDigest: String(row.declared_digest), actualSize: row.actual_size === null ? null : Number(row.actual_size), actualDigest: row.actual_digest === null ? null : String(row.actual_digest), status, originalName: String(row.original_name), mediaType: String(row.media_type), stagedPath: String(row.staged_path), createdAt: String(row.created_at), promotedAt: row.promoted_at === null ? null : String(row.promoted_at), supersedesAttachmentId: row.supersedes_attachment_id === null || row.supersedes_attachment_id === undefined ? null : String(row.supersedes_attachment_id) };
}

function isHexDigest(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length !== 64) return false;
  return /^[0-9a-f]+$/.test(value);
}

function assertAttachmentMutationAllowed(database: SqliteDatabase, attachment: Attachment, session: Session): void {
  const role = requireProjectRole(database, attachment.projectId, session.userId, "contributor");
  if (attachment.uploaderUserId !== session.userId && role !== "maintainer" && role !== "owner") {
    throw forbidden("Only the uploader or a project maintainer may modify a staged attachment", {
      attachmentId: attachment.id,
      uploaderUserId: attachment.uploaderUserId
    });
  }
}

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}
