import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdir, readdir, rename, rmdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommentAttachmentDigestLifecycle } from "../attachments/digestLifecycle.js";
import { humanAuthContextSchema } from "../identity/schemas.js";
import { openServerDatabase } from "../sqlite.js";
import {
  setup,
  bootstrap,
  auth,
  createPending,
  uploadPending,
  finalizePending
} from "./support/commentAttachmentHttpFixture.js";
const filesystem = vi.hoisted(() => ({
  pause: undefined as undefined | ((path: string) => Promise<void>)
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    realpath: async (...args: Parameters<typeof actual.realpath>) => {
      const result = await actual.realpath(...args);
      if (filesystem.pause) await filesystem.pause(String(args[0]));
      return result;
    }
  };
});
afterEach(() => {
  filesystem.pause = undefined;
  vi.restoreAllMocks();
});

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const payload = Buffer.from("shared lifecycle original bytes");
const digest = createHash("sha256").update(payload).digest("hex");
function blobPath(directory: string, sha = digest) {
  return join(directory, "comment-attachments", "sha256", sha.slice(0, 2), sha);
}
async function stage(origin: string, token: string, projectId = "project-a", bytes = payload) {
  const sha = createHash("sha256").update(bytes).digest("hex");
  const created = await createPending(origin, token, projectId, {
    expectedSizeBytes: bytes.length,
    mediaType: "text/plain",
    expectedDigestSha256: sha,
    ttlMs: 60_000
  });
  expect(created.response.status).toBe(201);
  return created.payload.pendingUploadId as string;
}
async function assertDownload(
  stack: Awaited<ReturnType<typeof setup>>,
  token: string,
  id: string,
  projectId = "project-a",
  bytes = payload
) {
  const sha = createHash("sha256").update(bytes).digest("hex");
  expect((await finalizePending(stack.origin, token, projectId, id, sha)).response.status).toBe(
    200
  );
  const response = await fetch(
    `${stack.origin}/api/v1/projects/${projectId}/attachments/pending/${id}`,
    { headers: auth(token) }
  );
  expect(response.status).toBe(200);
  expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  expect(await readFile(blobPath(stack.directory, sha))).toEqual(bytes);
  expect(stack.blobs.get(sha)?.sizeBytes).toBe(bytes.length);
  expect(
    stack.database
      .prepare("SELECT status,digest_sha256 FROM comment_pending_uploads WHERE pending_upload_id=?")
      .get(id)
  ).toMatchObject({ status: "finalized", digest_sha256: sha });
}

describe("comment attachment lifecycle", () => {
  it("expires finalized unbound drafts at the TTL boundary and retains bound audit bytes", async () => {
    let now = new Date("2026-07-24T12:00:00.000Z");
    const stack = await setup({ clock: () => now });
    const token = await bootstrap(stack.origin);
    const id = await stage(stack.origin, token);
    await uploadPending(stack.origin, token, "project-a", id, payload, "text/plain", digest);
    now = new Date(now.getTime() + 30_000);
    expect(
      (await finalizePending(stack.origin, token, "project-a", id, digest)).response.status
    ).toBe(200);
    now = new Date(now.getTime() + 59_999);
    expect(
      await stack.attachmentService.cleanupExpiredStaged(stack.workspaceA, "project-a")
    ).toEqual({ removedPending: 0, removedBlobs: 0 });
    expect(
      (await finalizePending(stack.origin, token, "project-a", id, digest)).response.status
    ).toBe(200);
    now = new Date(now.getTime() + 1);
    expect(() =>
      stack.attachmentRepository.bindCommentAttachments({
        workspaceId: stack.workspaceA,
        projectId: "project-a",
        commentId: "expired-comment",
        attachments: [
          {
            pendingUploadId: id,
            digestSha256: digest,
            sizeBytes: payload.length,
            mediaType: "text/plain",
            createdAt: now.toISOString()
          }
        ],
        createdAt: now.toISOString()
      })
    ).toThrow(expect.objectContaining({ code: "attachment_pending_expired" }));
    expect(
      await stack.attachmentService.cleanupExpiredStaged(stack.workspaceA, "project-a")
    ).toEqual({ removedPending: 1, removedBlobs: 1 });
    await expect(readFile(blobPath(stack.directory))).rejects.toMatchObject({ code: "ENOENT" });

    const bound = await stage(stack.origin, token);
    await uploadPending(stack.origin, token, "project-a", bound, payload, "text/plain", digest);
    await finalizePending(stack.origin, token, "project-a", bound, digest);
    const record = stack.attachmentRepository.getPendingRequired(
      stack.workspaceA,
      "project-a",
      bound
    );
    stack.attachmentRepository.bindCommentAttachments({
      workspaceId: stack.workspaceA,
      projectId: "project-a",
      commentId: "comment-audit",
      attachments: [
        {
          pendingUploadId: bound,
          digestSha256: digest,
          sizeBytes: payload.length,
          mediaType: "text/plain",
          createdAt: record.finalizedAt!
        }
      ],
      createdAt: now.toISOString()
    });
    stack.attachmentService.setCommentTombstoned({
      workspaceId: stack.workspaceA,
      projectId: "project-a",
      commentId: "comment-audit"
    });
    now = new Date(now.getTime() + 120_000);
    expect(
      await stack.attachmentService.cleanupExpiredStaged(stack.workspaceA, "project-a")
    ).toEqual({ removedPending: 0, removedBlobs: 0 });
    expect(await readFile(blobPath(stack.directory))).toEqual(payload);
    expect(
      stack.attachmentRepository.getBindingRequired(
        stack.workspaceA,
        "project-a",
        "comment-audit",
        digest
      ).commentTombstonedAt
    ).toBeDefined();
  });

  it.each([
    true,
    false
  ])("reports claim release failure with action failure=%s and allows recovery", async (actionFails) => {
    const stack = await setup();
    const claims = new DatabaseSync(
      join(stack.directory, "comment-attachments", "lifecycle.sqlite")
    );
    const primary = Object.assign(new Error("original attachment I/O failure"), { code: "EIO" });
    try {
      claims.exec(
        "CREATE TRIGGER reject_release BEFORE DELETE ON attachment_digest_claims BEGIN SELECT RAISE(ABORT,'release_failed'); END;"
      );
      let observed: unknown;
      try {
        await stack.lifecycle.withDigest(digest, async () => {
          if (actionFails) throw primary;
          return "completed";
        });
      } catch (error) {
        observed = error;
      }
      if (actionFails) {
        expect(observed).toBe(primary);
        expect(primary).toMatchObject({ code: "EIO", cause: { message: "release_failed" } });
      } else {
        expect(observed).toMatchObject({ message: "release_failed" });
      }
      claims.exec("DROP TRIGGER reject_release");
      expect(await stack.lifecycle.withDigest(digest, async () => "recovered")).toBe("recovered");
      expect(
        claims.prepare("SELECT count(*) AS count FROM attachment_digest_claims").get()?.count
      ).toBe(0);
    } finally {
      claims.close();
    }
  });

  it("keeps the stream failure and real staging removal diagnostic", async () => {
    const stack = await setup();
    const primary = Object.assign(new Error("stream failed"), { code: "EIO" });
    let observed: unknown;
    try {
      await stack.blobs.stage({
        expectedSha256: digest,
        expectedSizeBytes: payload.length,
        mediaType: "text/plain",
        chunks: (async function* () {
          yield payload.subarray(0, 1);
          const directory = join(stack.directory, "comment-attachments", "tmp");
          const [file] = await readdir(directory);
          expect(file).toBeDefined();
          const path = join(directory, file!);
          await rename(path, join(stack.directory, "saved-staging-bytes"));
          await mkdir(path);
          throw primary;
        })()
      });
    } catch (error) {
      observed = error;
    }
    expect(observed).toBe(primary);
    expect(primary).toMatchObject({
      code: "EIO",
      cause: { code: expect.stringMatching(/EISDIR|EPERM/) }
    });
    expect(await readFile(join(stack.directory, "saved-staging-bytes"))).toEqual(
      payload.subarray(0, 1)
    );
  });

  it("keeps the reference SQL failure when uploaded staging disposal also fails", async () => {
    const stack = await setup();
    const token = await bootstrap(stack.origin);
    const id = await stage(stack.origin, token);
    const originalStage = stack.blobs.stage.bind(stack.blobs);
    let path: string | undefined;
    let dispose: (() => Promise<void>) | undefined;
    const saved = join(stack.directory, "saved-upload-staging");
    vi.spyOn(stack.blobs, "stage").mockImplementationOnce(async (input) => {
      const staged = await originalStage(input);
      dispose = staged.dispose;
      return {
        ...staged,
        publish: async () => {
          const metadata = await staged.publish();
          const directory = join(stack.directory, "comment-attachments", "tmp");
          const [file] = await readdir(directory);
          expect(file).toBeDefined();
          path = join(directory, file!);
          await rename(path, saved);
          await mkdir(path);
          return metadata;
        }
      };
    });
    stack.database.exec(
      "CREATE TRIGGER reject_reference BEFORE UPDATE ON comment_pending_uploads WHEN NEW.status='uploaded' BEGIN SELECT RAISE(ABORT,'reference_commit_failed'); END;"
    );
    const actor = humanAuthContextSchema.parse({
      humanPrincipalId: "human-owner-1",
      displayName: "Owner",
      deviceCredentialId: "device",
      projectId: "project-a",
      role: "owner",
      membershipId: "membership"
    });
    await expect(
      stack.attachmentService.uploadBody({
        actor,
        workspaceId: stack.workspaceA,
        projectId: "project-a",
        pendingUploadId: id,
        declaredDigestSha256: digest,
        contentLength: payload.length,
        mediaType: "text/plain",
        chunks: (async function* () {
          yield payload;
        })()
      })
    ).rejects.toMatchObject({
      message: "reference_commit_failed",
      code: "ERR_SQLITE_ERROR",
      cause: { code: expect.stringMatching(/EISDIR|EPERM/) }
    });
    expect(await readFile(saved)).toEqual(payload);
    expect(
      stack.attachmentRepository.getPendingRequired(stack.workspaceA, "project-a", id).status
    ).toBe("pending");
    expect(path).toBeDefined();
    expect(dispose).toBeDefined();
    await rmdir(path!);
    await rename(saved, path!);
    await dispose!();
    stack.database.exec("DROP TRIGGER reject_reference");
    expect(
      (await uploadPending(stack.origin, token, "project-a", id, payload, "text/plain", digest))
        .response.status
    ).toBe(201);
    await assertDownload(stack, token, id);
  });

  it("keeps upload unpublished while GC owns the zero-reference window", async () => {
    let now = new Date("2026-07-24T12:00:00.000Z");
    const first = await setup({ clock: () => now });
    const second = await setup({ directory: first.directory, clock: () => now });
    const token = await bootstrap(first.origin);
    const old = await stage(first.origin, token);
    expect(
      (await uploadPending(first.origin, token, "project-a", old, payload, "text/plain", digest))
        .response.status
    ).toBe(201);
    now = new Date(now.getTime() + 120_000);
    const next = await stage(second.origin, token);
    const entered = signal();
    const release = signal();
    const attempted = signal();
    let paused = false;
    filesystem.pause = async (path) => {
      if (path === blobPath(first.directory) && !paused) {
        paused = true;
        entered.resolve();
        await release.promise;
      }
    };
    const original = second.lifecycle.withDigest.bind(second.lifecycle);
    vi.spyOn(second.lifecycle, "withDigest").mockImplementation(
      async <T>(sha: string, action: () => Promise<T>) => {
        attempted.resolve();
        return original(sha, action);
      }
    );
    const cleaning = first.attachmentService.cleanupExpiredStaged(first.workspaceA, "project-a");
    await entered.promise;
    expect(
      first.database
        .prepare(
          "SELECT count(*) AS count FROM comment_pending_uploads WHERE digest_sha256=? AND status IN ('uploaded','finalized')"
        )
        .get(digest)?.count
    ).toBe(0);
    const uploading = uploadPending(
      second.origin,
      token,
      "project-a",
      next,
      payload,
      "text/plain",
      digest
    );
    let observedStatus: string | undefined;
    try {
      await Promise.race([attempted.promise, uploading.then(() => undefined)]);
      observedStatus = second.attachmentRepository.getPendingRequired(
        second.workspaceA,
        "project-a",
        next
      ).status;
      expect(await readFile(blobPath(first.directory))).toEqual(payload);
    } finally {
      release.resolve();
      await Promise.allSettled([cleaning, uploading]);
    }
    expect(await cleaning).toEqual({ removedPending: 1, removedBlobs: 1 });
    expect((await uploading).response.status).toBe(201);
    await assertDownload(second, token, next);
    expect(observedStatus).toBe("pending");
  });

  it("waits for published bytes and the reference commit before GC rechecks", async () => {
    let now = new Date("2026-07-24T12:00:00.000Z");
    const first = await setup({ clock: () => now });
    const second = await setup({ directory: first.directory, clock: () => now });
    const token = await bootstrap(first.origin);
    const old = await stage(first.origin, token);
    await uploadPending(first.origin, token, "project-a", old, payload, "text/plain", digest);
    now = new Date(now.getTime() + 120_000);
    const next = await stage(second.origin, token);
    const entered = signal();
    const release = signal();
    const gcAttempt = signal();
    const originalStage = second.blobs.stage.bind(second.blobs);
    vi.spyOn(second.blobs, "stage").mockImplementation(async (input) => {
      const staged = await originalStage(input);
      return {
        ...staged,
        publish: async () => {
          const metadata = await staged.publish();
          entered.resolve();
          await release.promise;
          return metadata;
        }
      };
    });
    const original = first.lifecycle.withDigest.bind(first.lifecycle);
    vi.spyOn(first.lifecycle, "withDigest").mockImplementation(
      async <T>(sha: string, action: () => Promise<T>) => {
        gcAttempt.resolve();
        return original(sha, action);
      }
    );
    const uploading = uploadPending(
      second.origin,
      token,
      "project-a",
      next,
      payload,
      "text/plain",
      digest
    );
    await entered.promise;
    const cleaning = first.attachmentService.cleanupExpiredStaged(first.workspaceA, "project-a");
    try {
      await gcAttempt.promise;
      expect(
        first.attachmentRepository.getPendingRequired(first.workspaceA, "project-a", old).status
      ).toBe("uploaded");
      expect(
        second.attachmentRepository.getPendingRequired(second.workspaceA, "project-a", next).status
      ).toBe("pending");
      expect(await readFile(blobPath(first.directory))).toEqual(payload);
    } finally {
      release.resolve();
    }
    expect((await uploading).response.status).toBe(201);
    expect(await cleaning).toEqual({ removedPending: 1, removedBlobs: 0 });
    await assertDownload(second, token, next);
  });

  it("lets a different digest finish while same-root GC is blocked", async () => {
    let now = new Date("2026-07-24T12:00:00.000Z");
    const stack = await setup({ clock: () => now });
    const token = await bootstrap(stack.origin);
    const old = await stage(stack.origin, token);
    await uploadPending(stack.origin, token, "project-a", old, payload, "text/plain", digest);
    now = new Date(now.getTime() + 120_000);
    const entered = signal();
    const release = signal();
    let paused = false;
    filesystem.pause = async (path) => {
      if (path === blobPath(stack.directory) && !paused) {
        paused = true;
        entered.resolve();
        await release.promise;
      }
    };
    const cleaning = stack.attachmentService.cleanupExpiredStaged(stack.workspaceA, "project-a");
    await entered.promise;
    const other = Buffer.from("another digest concurrently completes");
    try {
      const id = await stage(stack.origin, token, "project-a", other);
      expect(
        (await uploadPending(stack.origin, token, "project-a", id, other, "text/plain")).response
          .status
      ).toBe(201);
      await assertDownload(stack, token, id, "project-a", other);
    } finally {
      release.resolve();
    }
    expect((await cleaning).removedBlobs).toBe(1);
  });

  it("does not hold SQLite or a digest claim while receiving network bytes", async () => {
    const stack = await setup();
    const token = await bootstrap(stack.origin);
    const id = await stage(stack.origin, token);
    const entered = signal();
    const release = signal();
    const actor = humanAuthContextSchema.parse({
      humanPrincipalId: "human-owner-1",
      displayName: "Owner",
      deviceCredentialId: "device",
      projectId: "project-a",
      role: "owner" as const,
      membershipId: "membership"
    });
    const uploading = stack.attachmentService.uploadBody({
      actor,
      workspaceId: stack.workspaceA,
      projectId: "project-a",
      pendingUploadId: id,
      declaredDigestSha256: digest,
      contentLength: payload.length,
      mediaType: "text/plain",
      chunks: (async function* () {
        yield payload.subarray(0, 1);
        entered.resolve();
        await release.promise;
        yield payload.subarray(1);
      })()
    });
    await entered.promise;
    const connection = await openServerDatabase(join(stack.directory, "server.sqlite"), 0);
    try {
      connection.exec(
        "BEGIN IMMEDIATE; CREATE TABLE network_receive_write_probe(value INTEGER); COMMIT;"
      );
      const lifecycle = new CommentAttachmentDigestLifecycle(connection, stack.directory);
      await lifecycle.withDigest(digest, async () => {
        expect(
          connection
            .prepare("SELECT status FROM comment_pending_uploads WHERE pending_upload_id=?")
            .get(id)?.status
        ).toBe("pending");
      });
    } finally {
      connection.close();
      release.resolve();
    }
    expect((await uploading).status).toBe("uploaded");
    await assertDownload(stack, token, id);
  });

  it("protects shared bytes across projects until every staged reference expires", async () => {
    let now = new Date("2026-07-24T12:00:00.000Z");
    const stack = await setup({ clock: () => now });
    const tokenA = await bootstrap(stack.origin);
    const tokenB = await bootstrap(stack.origin, "project-b", "human-owner-b");
    const a = await stage(stack.origin, tokenA);
    await uploadPending(stack.origin, tokenA, "project-a", a, payload, "text/plain", digest);
    now = new Date(now.getTime() + 30_000);
    const b = await stage(stack.origin, tokenB, "project-b");
    await uploadPending(stack.origin, tokenB, "project-b", b, payload, "text/plain", digest);
    now = new Date(now.getTime() + 40_000);
    expect(
      await stack.attachmentService.cleanupExpiredStaged(stack.workspaceA, "project-a")
    ).toEqual({ removedPending: 1, removedBlobs: 0 });
    const response = await fetch(
      `${stack.origin}/api/v1/projects/project-b/attachments/pending/${b}`,
      { headers: auth(tokenB) }
    );
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(payload);
    expect(await readFile(blobPath(stack.directory))).toEqual(payload);
    now = new Date(now.getTime() + 30_000);
    expect(
      await stack.attachmentService.cleanupExpiredStaged(stack.workspaceB, "project-b")
    ).toEqual({ removedPending: 1, removedBlobs: 1 });
    expect(stack.blobs.get(digest)).toBeUndefined();
    await expect(readFile(blobPath(stack.directory))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retries a visible deletion I/O failure with intact metadata and bytes", async () => {
    let now = new Date("2026-07-24T12:00:00.000Z");
    const stack = await setup({ clock: () => now });
    const token = await bootstrap(stack.origin);
    const id = await stage(stack.origin, token);
    await uploadPending(stack.origin, token, "project-a", id, payload, "text/plain", digest);
    const path = blobPath(stack.directory);
    const saved = join(stack.directory, "saved-original-bytes");
    await rename(path, saved);
    await mkdir(path);
    now = new Date(now.getTime() + 120_000);
    await expect(
      stack.attachmentService.cleanupExpiredStaged(stack.workspaceA, "project-a")
    ).rejects.toMatchObject({ code: expect.stringMatching(/EISDIR|EPERM/) });
    expect(stack.blobs.get(digest)?.sizeBytes).toBe(payload.length);
    expect(await readFile(saved)).toEqual(payload);
    const response = await fetch(
      `${stack.origin}/api/v1/projects/project-a/attachments/by-digest/${digest}`,
      { headers: auth(token) }
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "attachment_not_found" });
    await rmdir(path);
    await rename(saved, path);
    expect(
      await stack.attachmentService.cleanupExpiredStaged(stack.workspaceA, "project-a")
    ).toEqual({ removedPending: 0, removedBlobs: 1 });
  });

  it("shares canonical-root claims and rejects unrelated databases on that root", async () => {
    const stack = await setup();
    const alias = join(stack.directory, "root-alias");
    await symlink(stack.directory, alias);
    const connection = await openServerDatabase(join(alias, "server.sqlite"), 5000);
    const other = await openServerDatabase(join(stack.directory, "unrelated.sqlite"), 5000);
    try {
      const lifecycle = new CommentAttachmentDigestLifecycle(connection, alias);
      const entered = signal();
      const release = signal();
      const held = stack.lifecycle.withDigest(digest, async () => {
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      let completed = false;
      const contender = lifecycle.withDigest(digest, async () => {
        completed = true;
      });
      try {
        await lifecycle.withDigest("a".repeat(64), async () => {
          expect(completed).toBe(false);
        });
        expect(() => new CommentAttachmentDigestLifecycle(other, stack.directory)).toThrow(
          "attachment_database_root_conflict"
        );
      } finally {
        release.resolve();
      }
      await Promise.all([held, contender]);
      expect(completed).toBe(true);
    } finally {
      connection.close();
      other.close();
    }
  });

  it("keeps an actual binding after cleanup already enumerated its candidate", async () => {
    const start = new Date("2026-07-24T12:00:00.000Z");
    let gcNow = start;
    const first = await setup({ clock: () => gcNow });
    const second = await setup({ directory: first.directory, clock: () => start });
    const token = await bootstrap(first.origin);
    const id = await stage(first.origin, token);
    await uploadPending(first.origin, token, "project-a", id, payload, "text/plain", digest);
    gcNow = new Date(start.getTime() + 120_000);
    const enumerated = signal();
    const release = signal();
    const original = first.lifecycle.withDigest.bind(first.lifecycle);
    let paused = false;
    vi.spyOn(first.lifecycle, "withDigest").mockImplementation(
      async <T>(sha: string, action: () => Promise<T>) => {
        if (!paused) {
          paused = true;
          enumerated.resolve();
          await release.promise;
        }
        return original(sha, action);
      }
    );
    const cleaning = first.attachmentService.cleanupExpiredStaged(first.workspaceA, "project-a");
    await enumerated.promise;
    try {
      expect(
        (await finalizePending(second.origin, token, "project-a", id, digest)).response.status
      ).toBe(200);
      first.attachmentRepository.bindCommentAttachments({
        workspaceId: first.workspaceA,
        projectId: "project-a",
        commentId: "comment-bound",
        attachments: [
          {
            pendingUploadId: id,
            digestSha256: digest,
            sizeBytes: payload.length,
            mediaType: "text/plain",
            createdAt: start.toISOString()
          }
        ],
        createdAt: start.toISOString()
      });
    } finally {
      release.resolve();
      await Promise.allSettled([cleaning]);
    }
    expect(await cleaning).toEqual({ removedPending: 0, removedBlobs: 0 });
    expect(await readFile(blobPath(first.directory))).toEqual(payload);
    expect(
      first.attachmentRepository.getBindingRequired(
        first.workspaceA,
        "project-a",
        "comment-bound",
        digest
      )
    ).toBeDefined();
  });

  it("recovers a failed reference commit without losing deduplicated bytes or a claim", async () => {
    const { origin, database, blobs, workspaceA, attachmentService } = await setup();
    const token = await bootstrap(origin);
    const bytes = Buffer.from("reference commit retry");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const created = await createPending(origin, token, "project-a", {
      expectedSizeBytes: bytes.length,
      mediaType: "text/plain",
      expectedDigestSha256: digest
    });
    const id = created.payload.pendingUploadId as string;
    database.exec(`CREATE TRIGGER reject_attachment_upload BEFORE UPDATE ON comment_pending_uploads
      WHEN NEW.status='uploaded' BEGIN SELECT RAISE(ABORT,'reference_commit_failed'); END;`);
    expect(
      (await uploadPending(origin, token, "project-a", id, bytes, "text/plain", digest)).response
        .status
    ).toBe(500);
    expect(blobs.get(digest)?.sizeBytes).toBe(bytes.length);
    expect(await attachmentService.cleanupExpiredStaged(workspaceA, "project-a")).toEqual({
      removedPending: 0,
      removedBlobs: 1
    });
    database.exec("DROP TRIGGER reject_attachment_upload");
    expect(
      (await uploadPending(origin, token, "project-a", id, bytes, "text/plain", digest)).response
        .status
    ).toBe(201);
    expect((await finalizePending(origin, token, "project-a", id)).response.status).toBe(200);
    const response = await fetch(`${origin}/api/v1/projects/project-a/attachments/pending/${id}`, {
      headers: auth(token)
    });
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  });

  it("retries metadata deletion after file removal without retaining an abandoned claim", async () => {
    let now = new Date("2026-07-24T12:00:00.000Z");
    const { origin, database, blobs, attachmentService, workspaceA } = await setup({
      clock: () => now
    });
    const token = await bootstrap(origin);
    const bytes = Buffer.from("metadata deletion retry");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const created = await createPending(origin, token, "project-a", {
      expectedSizeBytes: bytes.length,
      mediaType: "text/plain",
      expectedDigestSha256: digest,
      ttlMs: 60_000
    });
    const id = created.payload.pendingUploadId as string;
    expect(
      (await uploadPending(origin, token, "project-a", id, bytes, "text/plain", digest)).response
        .status
    ).toBe(201);
    now = new Date(now.getTime() + 120_000);
    database.exec(`CREATE TRIGGER reject_attachment_delete BEFORE DELETE ON comment_attachment_blobs
      BEGIN SELECT RAISE(ABORT,'metadata_delete_failed'); END;`);
    await expect(attachmentService.cleanupExpiredStaged(workspaceA, "project-a")).rejects.toThrow(
      "metadata_delete_failed"
    );
    expect(blobs.get(digest)?.sizeBytes).toBe(bytes.length);
    await expect(blobs.read(digest)).rejects.toMatchObject({ code: "ENOENT" });
    database.exec("DROP TRIGGER reject_attachment_delete");
    expect(await attachmentService.cleanupExpiredStaged(workspaceA, "project-a")).toEqual({
      removedPending: 0,
      removedBlobs: 1
    });
    expect(blobs.get(digest)).toBeUndefined();
  });

  it.each([
    "publication I/O",
    "metadata SQL"
  ])("retries failed %s before publishing a reference", async (phase) => {
    const { origin, directory, database, blobs } = await setup();
    const token = await bootstrap(origin);
    const bytes = Buffer.from("publication failure retry");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const created = await createPending(origin, token, "project-a", {
      expectedSizeBytes: bytes.length,
      mediaType: "text/plain",
      expectedDigestSha256: digest
    });
    const id = created.payload.pendingUploadId as string;
    const shard = join(directory, "comment-attachments", "sha256", digest.slice(0, 2));
    if (phase === "publication I/O") {
      await mkdir(join(directory, "comment-attachments", "sha256"), { recursive: true });
      await writeFile(shard, "blocked");
    } else {
      database.exec(`CREATE TRIGGER reject_blob_metadata BEFORE INSERT ON comment_attachment_blobs
        BEGIN SELECT RAISE(ABORT,'metadata_insert_failed'); END;`);
    }
    expect(
      (await uploadPending(origin, token, "project-a", id, bytes, "text/plain", digest)).response
        .status
    ).toBe(500);
    expect(blobs.get(digest)).toBeUndefined();
    expect(await readdir(join(directory, "comment-attachments", "tmp"))).toEqual([]);
    if (phase === "publication I/O") await rename(shard, join(directory, "blocked-shard"));
    else database.exec("DROP TRIGGER reject_blob_metadata");
    expect(
      (await uploadPending(origin, token, "project-a", id, bytes, "text/plain", digest)).response
        .status
    ).toBe(201);
    expect((await finalizePending(origin, token, "project-a", id)).response.status).toBe(200);
    const response = await fetch(`${origin}/api/v1/projects/project-a/attachments/pending/${id}`, {
      headers: auth(token)
    });
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  });
});
