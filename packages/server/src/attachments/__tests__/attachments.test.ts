import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DomainError, addMembership, createDevice, createSession, ensureUser, type Session } from "../../identity/index.js";
import { DEFAULT_ATTACHMENT_POLICY, completeAttachment, createAttachmentService, readAttachmentAuthorized, startAttachment, writeStagedBytes, type AttachmentService } from "../index.js";
import { cleanupTestHarness, createTestDatabase, seedMembership, seedProject, type TestHarness } from "../../identity/__tests__/testDatabase.js";

function digestFor(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function makeSession(database: TestHarness["database"], userId: string, deviceId: string, sessionId: string): Session {
  ensureUser(database, { deviceId, route: "/api/v1/users", key: `u-${userId}`, requestFingerprint: "f-1", userId, displayName: userId });
  createDevice(database, { deviceId, route: "/api/v1/devices", key: `d-${deviceId}`, requestFingerprint: "f-1", userId, id: deviceId, deviceName: deviceId });
  const session = createSession(database, { deviceId, route: "/api/v1/sessions", key: `s-${sessionId}`, requestFingerprint: "f-1", userId, id: sessionId, deviceRefId: deviceId, expiresAt: new Date(Date.now() + 60_000).toISOString() });
  return session.value.session;
}

describe("attachments module", () => {
  let harness: TestHarness;
  let service: AttachmentService;
  beforeEach(async () => {
    harness = await createTestDatabase();
    service = createAttachmentService({ database: harness.database, dataDirectory: harness.dataDirectory });
  });
  afterEach(async () => { await cleanupTestHarness(harness); });

  it("starts and completes a staged upload, promoting bytes to the canonical content-addressed path", async () => {
    await seedProject(harness.database, "project-attach", "Attach");
    addMembership(harness.database, { deviceId: "dev-1", route: "/api/v1/memberships", key: "m-attach", requestFingerprint: "f-1", actorUserId: "user-alice", projectId: "project-attach", userId: "user-alice", role: "contributor" });
    const session = makeSession(harness.database, "user-alice", "device-alice", "session-alice");

    const bytes = Buffer.from("hello attachment world", "utf8");
    const digest = digestFor(bytes);
    const start = startAttachment(service, session, { deviceId: "dev-1", route: "/api/v1/attachments/start", key: "att-start-1", requestFingerprint: "f-1", projectId: "project-attach", declaredSize: bytes.length, declaredDigest: digest, originalName: "greeting.txt", mediaType: "text/plain" });
    expect(start.value.attachment.status).toBe("staged");
    expect(start.value.stagedPath).toBe(join(harness.dataDirectory, "attachments", "staged", `${start.value.attachment.id}.bin`));
    writeStagedBytes(service, session, start.value.attachment.id, bytes);

    const complete = completeAttachment(service, session, { deviceId: "dev-1", route: "/api/v1/attachments/complete", key: "att-complete-1", requestFingerprint: "f-1", id: start.value.attachment.id });
    expect(complete.replayed).toBe(false);
    expect(complete.value.attachment.status).toBe("ready");
    expect(complete.value.attachment.actualDigest).toBe(digest);
    expect(complete.value.attachment.actualSize).toBe(bytes.length);
    expect(complete.value.deduplicated).toBe(false);

    const canonicalPath = join(harness.dataDirectory, "blobs", digest);
    expect(existsSync(canonicalPath)).toBe(true);
    expect(readFileSync(canonicalPath).toString("utf8")).toBe("hello attachment world");
    expect(existsSync(start.value.stagedPath)).toBe(false);

    const authorized = readAttachmentAuthorized(service, session, complete.value.attachment.id);
    expect(authorized.canonicalPath).toBe(canonicalPath);
  });

  it("rejects mismatched digests with validation_failed and does not promote", async () => {
    await seedProject(harness.database, "project-mm", "Mismatch");
    addMembership(harness.database, { deviceId: "dev-1", route: "/api/v1/memberships", key: "m-mm", requestFingerprint: "f-1", actorUserId: "user-alice", projectId: "project-mm", userId: "user-alice", role: "contributor" });
    const session = makeSession(harness.database, "user-alice", "device-alice", "session-alice");

    const bytes = Buffer.from("actual content", "utf8");
    const wrongDigest = "0".repeat(64);
    const start = startAttachment(service, session, { deviceId: "dev-1", route: "/api/v1/attachments/start", key: "att-mm-1", requestFingerprint: "f-1", projectId: "project-mm", declaredSize: bytes.length, declaredDigest: wrongDigest, originalName: "x.bin", mediaType: "application/octet-stream" });
    writeStagedBytes(service, session, start.value.attachment.id, bytes);

    let captured: DomainError | undefined;
    try { completeAttachment(service, session, { deviceId: "dev-1", route: "/api/v1/attachments/complete", key: "att-mm-c", requestFingerprint: "f-1", id: start.value.attachment.id }); } catch (error) { captured = error as DomainError; }
    expect(captured).toBeInstanceOf(DomainError);
    expect(captured?.code).toBe("validation_failed");
    const row = harness.database.prepare("SELECT status, actual_digest FROM attachments WHERE id=?").get(start.value.attachment.id) as { status: string; actual_digest: string };
    expect(row.status).toBe("failed");
    expect(row.actual_digest).toBe(digestFor(bytes));
  });

  it("deduplicates duplicate content in the same project without storing twice", async () => {
    await seedProject(harness.database, "project-dup", "Dup");
    addMembership(harness.database, { deviceId: "dev-1", route: "/api/v1/memberships", key: "m-dup", requestFingerprint: "f-1", actorUserId: "user-alice", projectId: "project-dup", userId: "user-alice", role: "contributor" });
    const session = makeSession(harness.database, "user-alice", "device-alice", "session-alice");
    const bytes = Buffer.from("duplicate bytes", "utf8");
    const digest = digestFor(bytes);

    const first = startAttachment(service, session, { deviceId: "dev-1", route: "/api/v1/attachments/start", key: "att-dup-1", requestFingerprint: "f-1", projectId: "project-dup", declaredSize: bytes.length, declaredDigest: digest, originalName: "a.txt", mediaType: "text/plain" });
    writeStagedBytes(service, session, first.value.attachment.id, bytes);
    completeAttachment(service, session, { deviceId: "dev-1", route: "/api/v1/attachments/complete", key: "att-dup-c-1", requestFingerprint: "f-1", id: first.value.attachment.id });

    const second = startAttachment(service, session, { deviceId: "dev-1", route: "/api/v1/attachments/start", key: "att-dup-2", requestFingerprint: "f-1", projectId: "project-dup", declaredSize: bytes.length, declaredDigest: digest, originalName: "b.txt", mediaType: "text/plain" });
    writeStagedBytes(service, session, second.value.attachment.id, bytes);
    const secondComplete = completeAttachment(service, session, { deviceId: "dev-1", route: "/api/v1/attachments/complete", key: "att-dup-c-2", requestFingerprint: "f-1", id: second.value.attachment.id });

    expect(secondComplete.value.deduplicated).toBe(true);
    expect(secondComplete.value.attachment.id).toBe(first.value.attachment.id);
    const rowCount = harness.database.prepare("SELECT COUNT(*) AS n FROM attachments WHERE project_id=? AND actual_digest=? AND status='ready'").get("project-dup", digest) as { n: number };
    expect(rowCount.n).toBe(1);
    expect(existsSync(join(harness.dataDirectory, "blobs", digest))).toBe(true);
  });

  it("keeps duplicate content in different projects as separate authorization domains", async () => {
    await seedProject(harness.database, "project-x", "X");
    await seedProject(harness.database, "project-y", "Y");
    addMembership(harness.database, { deviceId: "dev-1", route: "/api/v1/memberships", key: "m-x", requestFingerprint: "f-1", actorUserId: "user-alice", projectId: "project-x", userId: "user-alice", role: "contributor" });
    await seedMembership(harness.database, "project-y", "user-alice", "contributor");
    const session = makeSession(harness.database, "user-alice", "device-alice", "session-alice");
    const bytes = Buffer.from("shared content", "utf8");
    const digest = digestFor(bytes);

    const startX = startAttachment(service, session, { deviceId: "dev-1", route: "/api/v1/attachments/start", key: "att-x", requestFingerprint: "f-1", projectId: "project-x", declaredSize: bytes.length, declaredDigest: digest, originalName: "x.txt", mediaType: "text/plain" });
    writeStagedBytes(service, session, startX.value.attachment.id, bytes);
    const completeX = completeAttachment(service, session, { deviceId: "dev-1", route: "/api/v1/attachments/complete", key: "att-x-c", requestFingerprint: "f-1", id: startX.value.attachment.id });

    const startY = startAttachment(service, session, { deviceId: "dev-1", route: "/api/v1/attachments/start", key: "att-y", requestFingerprint: "f-1", projectId: "project-y", declaredSize: bytes.length, declaredDigest: digest, originalName: "y.txt", mediaType: "text/plain" });
    writeStagedBytes(service, session, startY.value.attachment.id, bytes);
    const completeY = completeAttachment(service, session, { deviceId: "dev-1", route: "/api/v1/attachments/complete", key: "att-y-c", requestFingerprint: "f-1", id: startY.value.attachment.id });

    expect(completeX.value.attachment.id).not.toBe(completeY.value.attachment.id);
    expect(completeY.value.deduplicated).toBe(false);
    expect(harness.database.prepare("SELECT COUNT(*) AS n FROM attachments WHERE actual_digest=? AND status='ready'").get(digest)).toEqual({ n: 2 });
    expect(existsSync(join(harness.dataDirectory, "blobs", digest))).toBe(true);
  });

  it("rejects cross-project reads with forbidden even when the digest matches", async () => {
    await seedProject(harness.database, "project-a", "A");
    await seedProject(harness.database, "project-b", "B");
    addMembership(harness.database, { deviceId: "dev-1", route: "/api/v1/memberships", key: "m-a", requestFingerprint: "f-1", actorUserId: "user-alice", projectId: "project-a", userId: "user-alice", role: "contributor" });
    const session = makeSession(harness.database, "user-alice", "device-alice", "session-alice");
    const bytes = Buffer.from("cross project data", "utf8");
    const digest = digestFor(bytes);
    const startA = startAttachment(service, session, { deviceId: "dev-1", route: "/api/v1/attachments/start", key: "att-a", requestFingerprint: "f-1", projectId: "project-a", declaredSize: bytes.length, declaredDigest: digest, originalName: "x.bin", mediaType: "application/octet-stream" });
    writeStagedBytes(service, session, startA.value.attachment.id, bytes);
    const completeA = completeAttachment(service, session, { deviceId: "dev-1", route: "/api/v1/attachments/complete", key: "att-a-c", requestFingerprint: "f-1", id: startA.value.attachment.id });

    addMembership(harness.database, { deviceId: "dev-2", route: "/api/v1/memberships", key: "m-b", requestFingerprint: "f-1", actorUserId: "user-bob", projectId: "project-b", userId: "user-bob", role: "contributor" });
    const bob = makeSession(harness.database, "user-bob", "device-bob", "session-bob");

    let captured: DomainError | undefined;
    try { readAttachmentAuthorized(service, bob, completeA.value.attachment.id); } catch (error) { captured = error as DomainError; }
    expect(captured).toBeInstanceOf(DomainError);
    expect(captured?.code).toBe("forbidden");
  });

  it("rejects oversize declared uploads with request_too_large", async () => {
    await seedProject(harness.database, "project-big", "Big");
    addMembership(harness.database, { deviceId: "dev-1", route: "/api/v1/memberships", key: "m-big", requestFingerprint: "f-1", actorUserId: "user-alice", projectId: "project-big", userId: "user-alice", role: "contributor" });
    const session = makeSession(harness.database, "user-alice", "device-alice", "session-alice");
    const declaredSize = DEFAULT_ATTACHMENT_POLICY.maxSizeBytes + 1;
    let captured: DomainError | undefined;
    try { startAttachment(service, session, { deviceId: "dev-1", route: "/api/v1/attachments/start", key: "att-big", requestFingerprint: "f-1", projectId: "project-big", declaredSize, declaredDigest: "0".repeat(64), originalName: "huge.bin", mediaType: "application/octet-stream" }); } catch (error) { captured = error as DomainError; }
    expect(captured).toBeInstanceOf(DomainError);
    expect(captured?.code).toBe("request_too_large");
    expect(captured?.details).toMatchObject({ declaredSize, maxSizeBytes: DEFAULT_ATTACHMENT_POLICY.maxSizeBytes });
  });
});
