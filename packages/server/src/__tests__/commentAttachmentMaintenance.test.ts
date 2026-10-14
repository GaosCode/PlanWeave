import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommentAttachmentMaintenance } from "../attachments/maintenance.js";
import { CommentAttachmentBlobStore } from "../attachments/blobStore.js";
import { createDistributedServerComposition } from "../serverComposition.js";
import type { AttachmentMaintenanceCursor } from "../attachments/service.js";
import { setup, bootstrap } from "./support/commentAttachmentHttpFixture.js";
import { setupCommentReadComposition } from "./support/commentReadAccessCompositionFixture.js";
import { finalizePending } from "./support/commentAttachmentHttpFixture.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function seedDraft(
  stack: Awaited<ReturnType<typeof setup>>,
  index: number,
  createdAt: string,
  workspaceId = stack.workspaceA,
  projectId = "project-a",
  uploader = "human-owner-1"
) {
  const bytes = Buffer.from(`maintenance persisted draft ${index}`);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const record = stack.attachmentRepository.createPendingUpload({
    workspaceId,
    projectId,
    uploaderHumanPrincipalId: uploader,
    expectedSizeBytes: bytes.length,
    expectedDigestSha256: digest,
    mediaType: "text/plain",
    createdAt,
    expiresAt: new Date(Date.parse(createdAt) + 60_000).toISOString()
  });
  await stack.blobs.put({
    expectedSha256: digest,
    expectedSizeBytes: bytes.length,
    mediaType: "text/plain",
    chunks: (async function* () {
      yield bytes;
    })()
  });
  stack.attachmentRepository.markUploaded({
    workspaceId,
    projectId,
    pendingUploadId: record.pendingUploadId,
    digestSha256: digest,
    sizeBytes: bytes.length,
    mediaType: "text/plain",
    uploadedAt: createdAt
  });
  stack.attachmentRepository.finalize({
    workspaceId,
    projectId,
    pendingUploadId: record.pendingUploadId,
    expected: {
      pendingUploadId: record.pendingUploadId,
      digestSha256: digest,
      sizeBytes: bytes.length,
      mediaType: "text/plain"
    },
    finalizedAt: createdAt
  });
  return { digest, pendingUploadId: record.pendingUploadId };
}

describe("comment attachment background maintenance", () => {
  it("reclaims abandoned finalized drafts through composition without a cleanup request", async () => {
    let now = new Date();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stack = await setupCommentReadComposition({ clock: () => now });
    const staged = await stack.stage(stack.owner.token, Buffer.from("abandoned finalized draft"));
    expect(
      (
        await finalizePending(
          stack.origin,
          stack.owner.token,
          stack.projectId,
          staged.pendingUploadId
        )
      ).response.status
    ).toBe(200);
    now = new Date(now.getTime() + 3_600_000);
    await vi.advanceTimersByTimeAsync(60_000);
    await stack.composition.close();
    expect(
      stack.database
        .prepare("SELECT 1 FROM comment_pending_uploads WHERE pending_upload_id=?")
        .get(staged.pendingUploadId)
    ).toBeUndefined();
    await expect(
      readFile(
        join(
          stack.directory,
          "comment-attachments",
          "sha256",
          staged.digestSha256.slice(0, 2),
          staged.digestSha256
        )
      )
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("bounds every candidate/delete attempt and reaches tail items despite persistent metadata and legacy failures", async () => {
    const createdAt = "2026-07-24T12:00:00.000Z";
    const now = new Date(Date.parse(createdAt) + 120_000);
    const stack = await setup({ clock: () => now });
    await bootstrap(stack.origin);
    await bootstrap(stack.origin, "project-b", "human-owner-b");
    const seeded = [];
    for (let index = 0; index < 120; index++)
      seeded.push(
        await seedDraft(
          stack,
          index,
          createdAt,
          index < 60 ? stack.workspaceA : stack.workspaceB,
          index < 60 ? "project-a" : "project-b",
          index < 60 ? "human-owner-1" : "human-owner-b"
        )
      );
    const first = stack.attachmentRepository.listExpiredDraftsForMaintenance(
      now.toISOString(),
      1
    )[0]!;
    stack.database.exec(
      `CREATE TRIGGER fail_one_metadata BEFORE DELETE ON comment_attachment_blobs WHEN OLD.digest_sha256='${first.digestSha256}' BEGIN SELECT RAISE(ABORT,'metadata_delete_failed'); END;`
    );
    const orphanDigests = [];
    for (let index = 0; index < 60; index++) {
      const bytes = Buffer.from(`orphan publication ${index}`);
      const digest = createHash("sha256").update(bytes).digest("hex");
      orphanDigests.push(digest);
      await stack.blobs.put({
        expectedSha256: digest,
        expectedSizeBytes: bytes.length,
        mediaType: "text/plain",
        chunks: (async function* () {
          yield bytes;
        })()
      });
    }
    const malformedDigest = [...orphanDigests].sort()[0]!;
    stack.database
      .prepare(
        `INSERT INTO comment_pending_uploads_unscoped_legacy VALUES('malformed','project-a',?,?)`
      )
      .run(
        JSON.stringify({ status: "finalized", digestSha256: malformedDigest, createdAt }),
        createdAt
      );
    const deletes = vi.spyOn(stack.blobs, "deleteIfUnreferenced");
    let cursor: AttachmentMaintenanceCursor = {};
    let failures = 0;
    for (let page = 0; page < 4; page++) {
      const before = deletes.mock.calls.length;
      const result = await stack.attachmentService.cleanupMaintenanceBatch(cursor, 100);
      cursor = result.cursor;
      expect(result.candidates).toBeLessThanOrEqual(100);
      expect(result.blobDeleteAttempts).toBe(deletes.mock.calls.length - before);
      expect(result.blobDeleteAttempts).toBeLessThanOrEqual(100);
      if (page === 0) expect(result.candidates).toBe(100);
      failures += result.failures.length;
    }
    expect(failures).toBeGreaterThan(0);
    expect(
      stack.database.prepare("SELECT count(*) AS count FROM comment_pending_uploads").get()?.count
    ).toBe(0);
    expect(stack.blobs.get(seeded.at(-1)!.digest)).toBeUndefined();
    expect(
      stack.database.prepare("SELECT count(*) AS count FROM comment_attachment_blobs").get()?.count
    ).toBe(2);
    await expect(stack.blobs.read(first.digestSha256!)).rejects.toMatchObject({ code: "ENOENT" });
    expect(stack.blobs.get(malformedDigest)).toBeDefined();
    stack.database.exec("DROP TRIGGER fail_one_metadata");
    stack.database
      .prepare(
        `UPDATE comment_pending_uploads_unscoped_legacy SET payload_json=json_set(payload_json,'$.expiresAt',?)`
      )
      .run(new Date(Date.parse(createdAt) + 60_000).toISOString());
    for (let page = 0; page < 2; page++)
      cursor = (await stack.attachmentService.cleanupMaintenanceBatch(cursor, 100)).cursor;
    expect(
      stack.database.prepare("SELECT count(*) AS count FROM comment_attachment_blobs").get()?.count
    ).toBe(0);
  });

  it("reports sanitized failures, backs off and recovers without losing the next scheduled sweep", async () => {
    const createdAt = "2026-07-24T12:00:00.000Z";
    const stack = await setup({ clock: () => new Date(Date.parse(createdAt) + 120_000) });
    await bootstrap(stack.origin);
    const draft = await seedDraft(stack, 1000, createdAt);
    stack.database.exec(
      "CREATE TRIGGER fail_metadata BEFORE DELETE ON comment_attachment_blobs BEGIN SELECT RAISE(ABORT,'metadata_delete_failed'); END;"
    );
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    const original = stack.attachmentService.cleanupMaintenanceBatch.bind(stack.attachmentService);
    let batch: ReturnType<typeof original> | undefined;
    const sweeps = vi
      .spyOn(stack.attachmentService, "cleanupMaintenanceBatch")
      .mockImplementation((...args) => {
        batch = original(...args);
        return batch;
      });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const maintenance = new CommentAttachmentMaintenance(stack.attachmentService);
    maintenance.start();
    expect(sweeps).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    await batch;
    await vi.advanceTimersByTimeAsync(0);
    expect(report).toHaveBeenCalledWith("comment_attachment_maintenance_failed", {
      phase: "draft",
      code: "ERR_SQLITE_ERROR",
      errorName: "Error"
    });
    expect(JSON.stringify(report.mock.calls)).not.toContain(draft.digest);
    expect(stack.blobs.get(draft.digest)).toBeDefined();
    await vi.advanceTimersByTimeAsync(119_999);
    expect(sweeps).toHaveBeenCalledTimes(1);
    stack.database.exec("DROP TRIGGER fail_metadata");
    await vi.advanceTimersByTimeAsync(1);
    await batch;
    await vi.advanceTimersByTimeAsync(0);
    expect(sweeps).toHaveBeenCalledTimes(2);
    expect(stack.blobs.get(draft.digest)).toBeUndefined();
    await maintenance.close();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(sweeps).toHaveBeenCalledTimes(2);
  });

  it("drains an active deletion, admits no second sweep, and resumes remaining bytes after restart", async () => {
    let now = new Date();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stack = await setupCommentReadComposition({ clock: () => now });
    const staged = await stack.stage(stack.owner.token, Buffer.from("shutdown protected bytes"));
    await finalizePending(stack.origin, stack.owner.token, stack.projectId, staged.pendingUploadId);
    now = new Date(now.getTime() + 3_600_000);
    const entered = signal();
    const release = signal();
    const original = CommentAttachmentBlobStore.prototype.deleteIfUnreferenced;
    const deleting = vi
      .spyOn(CommentAttachmentBlobStore.prototype, "deleteIfUnreferenced")
      .mockImplementationOnce(async function (this: CommentAttachmentBlobStore, digest, nowIso) {
        entered.resolve();
        await release.promise;
        return original.call(this, digest, nowIso);
      });
    await vi.advanceTimersByTimeAsync(60_000);
    await entered.promise;
    let closed = false;
    const closing = stack.composition.close().then(() => {
      closed = true;
    });
    try {
      await vi.advanceTimersByTimeAsync(600_000);
      expect(closed).toBe(false);
      expect(deleting).toHaveBeenCalledTimes(1);
      await expect(
        readFile(
          join(
            stack.directory,
            "comment-attachments",
            "sha256",
            staged.digestSha256.slice(0, 2),
            staged.digestSha256
          )
        )
      ).resolves.toEqual(Buffer.from("shutdown protected bytes"));
    } finally {
      release.resolve();
    }
    await closing;
    expect(closed).toBe(true);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(deleting).toHaveBeenCalledTimes(1);
    deleting.mockRestore();
    const bytes = Buffer.from("interrupted published orphan");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const blobs = new CommentAttachmentBlobStore(stack.database, stack.directory);
    await blobs.put({
      expectedSha256: digest,
      expectedSizeBytes: bytes.length,
      mediaType: "text/plain",
      chunks: (async function* () {
        yield bytes;
      })()
    });
    const restarted = await createDistributedServerComposition({
      httpServer: createServer(),
      config: stack.config,
      clock: () => now
    });
    expect(blobs.get(digest)).toBeDefined();
    await vi.advanceTimersByTimeAsync(60_000);
    await restarted.close();
    expect(blobs.get(digest)).toBeUndefined();
  });
});
