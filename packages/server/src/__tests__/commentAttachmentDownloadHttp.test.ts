import { createHash } from "node:crypto";
import { once } from "node:events";
import type { ReadStream } from "node:fs";
import { validateHeaderValue } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  setup,
  bootstrap,
  auth,
  createPending,
  uploadPending,
  finalizePending
} from "./support/commentAttachmentHttpFixture.js";

afterEach(() => vi.restoreAllMocks());

async function stage(fileName: string, bytes = Buffer.from([0, 255, 1, 128, 13, 10, 42])) {
  const fixture = await setup();
  const token = await bootstrap(fixture.origin);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const created = await createPending(fixture.origin, token, "project-a", {
    expectedSizeBytes: bytes.length,
    mediaType: "text/plain",
    fileName,
    expectedDigestSha256: digest
  });
  expect(created.response.status).toBe(201);
  const pendingId = created.payload.pendingUploadId as string;
  expect(
    (
      await uploadPending(
        fixture.origin,
        token,
        "project-a",
        pendingId,
        bytes,
        "text/plain",
        digest
      )
    ).response.status
  ).toBe(201);
  const finalized = await finalizePending(fixture.origin, token, "project-a", pendingId, digest);
  expect(finalized.response.status).toBe(200);
  const storedName = finalized.payload.fileName as string;
  fixture.attachmentService.bindCommentAttachments({
    actor: {
      humanPrincipalId: "human-owner-1",
      displayName: "Owner",
      deviceCredentialId: "device",
      projectId: "project-a",
      role: "owner",
      membershipId: "membership"
    },
    workspaceId: fixture.workspaceA,
    projectId: "project-a",
    commentId: "comment-download",
    attachments: [
      {
        digestSha256: digest,
        sizeBytes: bytes.length,
        mediaType: "text/plain",
        fileName: storedName,
        createdAt: new Date().toISOString()
      }
    ]
  });
  return { ...fixture, token, bytes, digest, pendingId, storedName };
}

describe("attachment download filename HTTP encoding", () => {
  it.each([
    "报告.pdf",
    "📎.txt",
    "report.pdf",
    "report 50% 'final'.txt",
    'quoted".txt',
    "报告",
    "bad\ud800.txt",
    "bad\udc00.txt"
  ])("preserves %s across pending and comment downloads", async (fileName) => {
    const test = await stage(fileName);
    // SQLite UTF-8 persistence replaces unpaired surrogates, as it does for other text.
    expect(test.storedName).toBe(Buffer.from(fileName, "utf8").toString("utf8"));
    for (const path of [`pending/${test.pendingId}`, `comments/comment-download/${test.digest}`]) {
      const response = await fetch(`${test.origin}/api/v1/projects/project-a/attachments/${path}`, {
        headers: auth(test.token)
      });
      expect.soft(response.status, path).toBe(200);
      if (response.status !== 200) {
        await response.text();
        continue;
      }
      const disposition = response.headers.get("content-disposition")!;
      expect(() => validateHeaderValue("content-disposition", disposition)).not.toThrow();
      const match = /^attachment; filename="([^"\\]*)"; filename\*=UTF-8''(.*)$/.exec(disposition);
      expect(match).not.toBeNull();
      expect(match![1]).toMatch(/^[\x20-\x7e]+$/);
      expect(match![1]).not.toMatch(/[%'\\]/);
      expect(decodeURIComponent(match![2])).toBe(test.storedName);
      if (fileName === "report.pdf") expect(match![1]).toBe(fileName);
      if (fileName.endsWith(".txt")) expect(match![1]).toMatch(/\.txt$/);
      const received = Buffer.from(await response.arrayBuffer());
      expect(received).toEqual(test.bytes);
      expect(createHash("sha256").update(received).digest("hex")).toBe(test.digest);
      expect(response.headers.get("etag")).toBe(`"sha256:${test.digest}"`);
      expect(response.headers.get("content-length")).toBe(String(test.bytes.length));
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    }
  });

  it.each([
    "inject\r\nHeader: value.txt",
    "../escape.txt",
    "path\\escape.txt",
    "nul\0.txt"
  ])("rejects invalid filename %s before staging", async (fileName) => {
    const { origin } = await setup();
    const token = await bootstrap(origin);
    const created = await createPending(origin, token, "project-a", {
      expectedSizeBytes: 1,
      mediaType: "text/plain",
      fileName
    });
    expect(created.response.status).toBe(400);
    expect(created.payload.error).toBe("attachment_input_invalid");
  });
});

describe("attachment HTTP opened-source cleanup", () => {
  it.each([
    "pending",
    "comment"
  ] as const)("closes the %s source when writeHead fails", async (route) => {
    const test = await stage("报告.pdf");
    let source: ReadStream | undefined;
    let closed: Promise<unknown> | undefined;
    // Spy on the shared blob boundary, preserving real authorization and native file ownership.
    const openBlob = test.blobs.openRead.bind(test.blobs);
    vi.spyOn(test.blobs, "openRead").mockImplementation(async (...args) => {
      const result = await openBlob(...args);
      source = result.stream;
      closed = once(source, "close");
      return result;
    });
    test.server.prependListener("request", (request, response) => {
      if (request.method !== "GET") return;
      vi.spyOn(response, "writeHead").mockImplementationOnce(() => {
        throw new Error("header failed");
      });
    });
    const path =
      route === "pending"
        ? `pending/${test.pendingId}`
        : `comments/comment-download/${test.digest}`;
    const response = await fetch(`${test.origin}/api/v1/projects/project-a/attachments/${path}`, {
      headers: auth(test.token)
    });
    expect(response.status).toBe(500);
    await response.text();
    await closed;
    expect(source?.closed).toBe(true);
    expect(source?.destroyed).toBe(true);
  });

  it.each([
    "client abort",
    "source error",
    "complete"
  ] as const)("releases the native source on %s", async (mode) => {
    const test = await stage("📎.txt", Buffer.alloc(256 * 1024, 42));
    let source: ReadStream | undefined;
    let closed: Promise<void> | undefined;
    const openBlob = test.blobs.openRead.bind(test.blobs);
    vi.spyOn(test.blobs, "openRead").mockImplementation(async (...args) => {
      const result = await openBlob(...args);
      source = result.stream;
      closed = new Promise<void>((resolve) => source!.once("close", resolve));
      if (mode === "client abort") source.once("data", () => source!.pause());
      if (mode === "source error")
        source.once("resume", () => source!.destroy(new Error("read failed")));
      return result;
    });
    const download = fetch(
      `${test.origin}/api/v1/projects/project-a/attachments/pending/${test.pendingId}`,
      { headers: auth(test.token) }
    );
    if (mode === "source error") {
      await expect(download.then((response) => response.arrayBuffer())).rejects.toThrow();
    } else {
      const response = await download;
      expect(response.status).toBe(200);
      if (mode === "client abort") {
        const reader = response.body!.getReader();
        expect((await reader.read()).done).toBe(false);
        await reader.cancel();
      } else {
        expect(Buffer.from(await response.arrayBuffer())).toEqual(test.bytes);
      }
    }
    await closed;
    expect(source?.closed).toBe(true);
    expect(source?.destroyed).toBe(true);
    expect(source?.readableEnded).toBe(mode === "complete");
  });
});
