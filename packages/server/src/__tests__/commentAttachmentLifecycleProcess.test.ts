import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CommentAttachmentDigestLifecycle } from "../attachments/digestLifecycle.js";
import { openServerDatabase } from "../sqlite.js";
import { AttachmentProcessHarness } from "./support/commentAttachmentProcessHarness.js";
import {
  auth,
  setup,
  bootstrap,
  createPending,
  uploadPending,
  finalizePending
} from "./support/commentAttachmentHttpFixture.js";

const bytes = Buffer.from("real process original attachment bytes");
const digest = createHash("sha256").update(bytes).digest("hex");
async function pending(origin: string, token: string) {
  const created = await createPending(origin, token, "project-a", {
    expectedSizeBytes: bytes.length,
    mediaType: "text/plain",
    expectedDigestSha256: digest,
    ttlMs: 60_000
  });
  expect(created.response.status).toBe(201);
  return created.payload.pendingUploadId as string;
}
async function download(origin: string, token: string, id: string, directory: string) {
  expect((await finalizePending(origin, token, "project-a", id, digest)).response.status).toBe(200);
  const response = await fetch(`${origin}/api/v1/projects/project-a/attachments/pending/${id}`, {
    headers: auth(token)
  });
  expect(response.status).toBe(200);
  expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  expect(
    await readFile(join(directory, "comment-attachments", "sha256", digest.slice(0, 2), digest))
  ).toEqual(bytes);
}
function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("comment attachment multi-process lifecycle", () => {
  it.each([
    "finalize",
    "bind"
  ] as const)("linearizes %s against GC in independent processes", async (operation) => {
    const start = new Date("2026-07-24T12:00:00.000Z");
    const now = new Date(start.getTime() + 50_000);
    const stack = await setup({ clock: () => start });
    const token = await bootstrap(stack.origin);
    const old = await pending(stack.origin, token);
    await uploadPending(stack.origin, token, "project-a", old, bytes, "text/plain", digest);
    if (operation === "bind") await finalizePending(stack.origin, token, "project-a", old, digest);
    const contender = new AttachmentProcessHarness({
      directory: stack.directory,
      now: now.toISOString(),
      mode: "normal"
    });
    const contenderOrigin = await contender.ready();
    const collector = new AttachmentProcessHarness({
      directory: stack.directory,
      now: new Date(start.getTime() + 90_000).toISOString(),
      mode: "hold-gc-entry"
    });
    let cleaning: Promise<Response> | undefined;
    try {
      const gcOrigin = await collector.ready();
      cleaning = fetch(`${gcOrigin}/api/v1/projects/project-a/attachments/cleanup`, {
        method: "POST",
        headers: auth(token)
      });
      await collector.waitFor("gc-entry-held");
      if (operation === "finalize") {
        expect(
          (await finalizePending(contenderOrigin, token, "project-a", old, digest)).response.status
        ).toBe(200);
      } else {
        contender.bind(old);
        await contender.waitFor("bound");
      }
      collector.release();
      const response = await cleaning;
      expect(await response.json()).toEqual({ removedPending: 0, removedBlobs: 0 });
      expect(await stack.blobs.read(digest)).toEqual(bytes);
    } finally {
      await collector.dispose();
      await contender.dispose();
      await cleaning;
    }
  }, 20000);

  it.each([
    "finalize",
    "bind"
  ] as const)("rejects %s after another process revokes the expired reference", async (operation) => {
    const start = new Date("2026-07-24T12:00:00.000Z");
    const stack = await setup({ clock: () => start });
    const token = await bootstrap(stack.origin);
    const old = await pending(stack.origin, token);
    await uploadPending(stack.origin, token, "project-a", old, bytes, "text/plain", digest);
    await finalizePending(stack.origin, token, "project-a", old, digest);
    const contender = new AttachmentProcessHarness({
      directory: stack.directory,
      now: new Date(start.getTime() + 50_000).toISOString(),
      mode: "normal"
    });
    const contenderOrigin = await contender.ready();
    const collector = new AttachmentProcessHarness({
      directory: stack.directory,
      now: new Date(start.getTime() + 90_000).toISOString(),
      mode: "hold-gc"
    });
    let cleaning: Promise<Response> | undefined;
    try {
      const gcOrigin = await collector.ready();
      cleaning = fetch(`${gcOrigin}/api/v1/projects/project-a/attachments/cleanup`, {
        method: "POST",
        headers: auth(token)
      });
      await collector.waitFor("gc-held");
      if (operation === "finalize") {
        expect(
          (await finalizePending(contenderOrigin, token, "project-a", old, digest)).response.status
        ).toBe(404);
      } else {
        contender.bind(old);
        const denied = await contender.waitFor("bind-denied");
        expect(denied.message).toBe("Pending attachment upload was not found in this project.");
      }
      collector.release();
      expect(await (await cleaning).json()).toEqual({ removedPending: 1, removedBlobs: 1 });
      expect(
        stack.attachmentRepository.getBinding(
          stack.workspaceA,
          "project-a",
          "process-comment",
          digest
        )
      ).toBeUndefined();
      expect(stack.blobs.get(digest)).toBeUndefined();
    } finally {
      await collector.dispose();
      await contender.dispose();
      await cleaning;
    }
  }, 20000);

  it("does not steal an active owner when hostname and PID namespace identity differ", async () => {
    let now = new Date("2026-07-24T12:00:00.000Z");
    const stack = await setup({ clock: () => now });
    const token = await bootstrap(stack.origin);
    const old = await pending(stack.origin, token);
    await uploadPending(stack.origin, token, "project-a", old, bytes, "text/plain", digest);
    now = new Date(now.getTime() + 120_000);
    const next = await pending(stack.origin, token);
    const child = new AttachmentProcessHarness({
      directory: stack.directory,
      now: now.toISOString(),
      mode: "hold-gc"
    });
    let cleaning: Promise<Response> | undefined;
    let uploading: ReturnType<typeof uploadPending> | undefined;
    const attempted = signal();
    const original = stack.lifecycle.withDigest.bind(stack.lifecycle);
    const spy = vi
      .spyOn(stack.lifecycle, "withDigest")
      .mockImplementation(async <T>(sha: string, action: () => Promise<T>) => {
        attempted.resolve();
        return original(sha, action);
      });
    try {
      const origin = await child.ready();
      cleaning = fetch(`${origin}/api/v1/projects/project-a/attachments/cleanup`, {
        method: "POST",
        headers: auth(token)
      });
      await child.waitFor("gc-held");
      const ownerDatabase = await openServerDatabase(
        join(stack.directory, "comment-attachments", "lifecycle.sqlite"),
        5000
      );
      try {
        ownerDatabase
          .prepare("UPDATE attachment_digest_claims SET hostname=?,process_id=? WHERE digest=?")
          .run("another-container-hostname", process.pid, digest);
      } finally {
        ownerDatabase.close();
      }
      uploading = uploadPending(
        stack.origin,
        token,
        "project-a",
        next,
        bytes,
        "text/plain",
        digest
      );
      await attempted.promise;
      expect(
        stack.attachmentRepository.getPendingRequired(stack.workspaceA, "project-a", next).status
      ).toBe("pending");
      const other = await openServerDatabase(
        join(stack.directory, "comment-attachments", "lifecycle.sqlite"),
        5000
      );
      try {
        expect(
          other.prepare("SELECT hostname FROM attachment_digest_claims WHERE digest=?").get(digest)
            ?.hostname
        ).toBe("another-container-hostname");
      } finally {
        other.close();
      }
      child.release();
      const response = await cleaning;
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ removedPending: 1, removedBlobs: 1 });
      expect((await uploading).response.status).toBe(201);
      await download(origin, token, next, stack.directory);
      expect(
        stack.attachmentRepository.getPendingRequired(stack.workspaceA, "project-a", next).status
      ).toBe("finalized");
      expect(stack.blobs.get(digest)?.sizeBytes).toBe(bytes.length);
    } finally {
      spy.mockRestore();
      await child.dispose();
      await Promise.allSettled([cleaning, uploading].filter((value) => value !== undefined));
    }
  }, 20000);

  it("waits for a different process to commit a republished reference before GC rechecks", async () => {
    let now = new Date("2026-07-24T12:00:00.000Z");
    const stack = await setup({ clock: () => now });
    const token = await bootstrap(stack.origin);
    const old = await pending(stack.origin, token);
    await uploadPending(stack.origin, token, "project-a", old, bytes, "text/plain", digest);
    now = new Date(now.getTime() + 120_000);
    const next = await pending(stack.origin, token);
    const publisher = new AttachmentProcessHarness({
      directory: stack.directory,
      now: now.toISOString(),
      mode: "hold-publish"
    });
    let uploading: ReturnType<typeof uploadPending> | undefined;
    let cleaning: ReturnType<typeof stack.attachmentService.cleanupExpiredStaged> | undefined;
    const attempted = signal();
    const original = stack.lifecycle.withDigest.bind(stack.lifecycle);
    const spy = vi
      .spyOn(stack.lifecycle, "withDigest")
      .mockImplementation(async <T>(sha: string, action: () => Promise<T>) => {
        attempted.resolve();
        return original(sha, action);
      });
    try {
      const origin = await publisher.ready();
      uploading = uploadPending(origin, token, "project-a", next, bytes, "text/plain", digest);
      await publisher.waitFor("publish-held");
      cleaning = stack.attachmentService.cleanupExpiredStaged(stack.workspaceA, "project-a");
      await attempted.promise;
      expect(
        stack.attachmentRepository.getPendingRequired(stack.workspaceA, "project-a", old).status
      ).toBe("uploaded");
      expect(
        stack.attachmentRepository.getPendingRequired(stack.workspaceA, "project-a", next).status
      ).toBe("pending");
      publisher.release();
      expect((await uploading).response.status).toBe(201);
      expect(await cleaning).toEqual({ removedPending: 1, removedBlobs: 0 });
      await download(origin, token, next, stack.directory);
    } finally {
      spy.mockRestore();
      await publisher.dispose();
      await Promise.allSettled([uploading, cleaning].filter((value) => value !== undefined));
    }
  }, 20000);

  it("recovers a killed publishing owner after persistent volume reuse with a new hostname", async () => {
    const now = new Date("2026-07-24T12:00:00.000Z");
    const stack = await setup({ clock: () => now });
    const token = await bootstrap(stack.origin);
    const id = await pending(stack.origin, token);
    const child = new AttachmentProcessHarness({
      directory: stack.directory,
      now: now.toISOString(),
      mode: "hold-publish"
    });
    let restarted: AttachmentProcessHarness | undefined;
    let uploading: Promise<unknown> | undefined;
    try {
      const origin = await child.ready();
      uploading = uploadPending(origin, token, "project-a", id, bytes, "text/plain", digest).catch(
        (error: unknown) => error
      );
      await child.waitFor("publish-held");
      expect(
        stack.attachmentRepository.getPendingRequired(stack.workspaceA, "project-a", id).status
      ).toBe("pending");
      expect(stack.blobs.get(digest)?.sizeBytes).toBe(bytes.length);
      expect(
        await readFile(
          join(stack.directory, "comment-attachments", "sha256", digest.slice(0, 2), digest)
        )
      ).toEqual(bytes);
      const oldClaims = await openServerDatabase(
        join(stack.directory, "comment-attachments", "lifecycle.sqlite"),
        5000
      );
      try {
        oldClaims
          .prepare("UPDATE attachment_digest_claims SET hostname=?,process_id=? WHERE digest=?")
          .run("previous-container-hostname", process.pid, digest);
      } finally {
        oldClaims.close();
      }
      await child.crash();
      await uploading;
      restarted = new AttachmentProcessHarness({
        directory: stack.directory,
        now: now.toISOString(),
        mode: "normal"
      });
      const recoveredOrigin = await restarted.ready();
      expect(
        (await uploadPending(recoveredOrigin, token, "project-a", id, bytes, "text/plain", digest))
          .response.status
      ).toBe(201);
      await download(recoveredOrigin, token, id, stack.directory);
      expect(
        stack.attachmentRepository.getPendingRequired(stack.workspaceA, "project-a", id).status
      ).toBe("finalized");
      const claims = await openServerDatabase(
        join(stack.directory, "comment-attachments", "lifecycle.sqlite"),
        5000
      );
      try {
        expect(
          claims.prepare("SELECT count(*) AS count FROM attachment_digest_claims").get()?.count
        ).toBe(0);
      } finally {
        claims.close();
      }
    } finally {
      await child.dispose();
      await restarted?.dispose();
      await uploading;
    }
  }, 20000);

  it.each([
    hostname(),
    "unverified-old-container"
  ])("fails closed for an unverified legacy owner on %s", async (ownerHostname) => {
    const stack = await setup();
    const claims = await openServerDatabase(
      join(stack.directory, "comment-attachments", "lifecycle.sqlite"),
      5000
    );
    const ownerToken = randomUUID();
    try {
      if (
        claims
          .prepare("PRAGMA table_info(attachment_digest_claims)")
          .all()
          .some((column) => column.name === "coordination_version")
      ) {
        claims.exec("ALTER TABLE attachment_digest_claims DROP COLUMN coordination_version");
      }
      claims
        .prepare(`INSERT INTO attachment_digest_claims
            (digest,owner_token,process_id,hostname,process_instance) VALUES(?,?,?,?,?)`)
        .run(digest, ownerToken, 2147483647, ownerHostname, randomUUID());
      const migrated = new CommentAttachmentDigestLifecycle(stack.database, stack.directory);
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(migrated.withDigest(digest, async () => "must not enter")).rejects.toThrow(
          /legacy_owner_unverified.*stop.*drain.*offline/
        );
      }
      expect(
        claims
          .prepare("SELECT owner_token FROM attachment_digest_claims WHERE digest=?")
          .get(digest)?.owner_token
      ).toBe(ownerToken);
    } finally {
      claims.close();
    }
  });
});
