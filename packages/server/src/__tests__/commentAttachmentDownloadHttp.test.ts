import { setupCommentReadComposition } from "./support/commentReadAccessCompositionFixture.js";
import { CommentAttachmentBlobStore } from "../attachments/blobStore.js";
import { hashHumanToken } from "../identity/index.js";
import { HumanIdentityRepository } from "../identity/repository.js";
import { ProjectRegistryRepository } from "../projectRegistryRepository.js";
import { CommentRepository } from "../comments/repository.js";
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
  finalizePending,
  inviteAndJoin
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
  const at = new Date().toISOString();
  new CommentRepository(fixture.database, fixture.workspaceA).insertUnlocked({
    commentId: "comment-download",
    projectId: "project-a",
    workItem: { kind: "task", canvasId: "default", taskId: "T-001" },
    authorHumanPrincipalId: "human-owner-1",
    body: "download",
    bodyFormat: "markdown",
    revision: 1,
    createdAt: at,
    updatedAt: at,
    attachments: []
  });
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
        pendingUploadId: pendingId,
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

describe("attachment live binding read access", () => {
  it("denies private bindings before opening bytes and permits a readable digest reference", async () => {
    const test = await stage("private.txt");
    const member = await inviteAndJoin(test.origin, test.token, "project-a", "Reader");
    const base = `${test.origin}/api/v1/projects/project-a/attachments`;
    expect(
      (
        await fetch(`${base}/comments/comment-download/${test.digest}`, {
          headers: auth(test.token)
        })
      ).status
    ).toBe(200);
    test.database
      .prepare(
        "UPDATE canvas_registry SET visibility='private' WHERE workspace_id=? AND project_id=? AND canvas_id=?"
      )
      .run(test.workspaceA, "project-a", "default");
    const open = vi.spyOn(test.blobs, "openRead");
    for (const path of [
      `comments/comment-download/${test.digest}`,
      `by-digest/${test.digest}`,
      `pending/${test.pendingId}`
    ]) {
      const denied = await fetch(`${base}/${path}`, { headers: auth(member) });
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({ error: "attachment_auth_forbidden" });
    }
    expect(open).not.toHaveBeenCalled();
    const allowed = await fetch(`${base}/comments/comment-download/${test.digest}`, {
      headers: auth(test.token)
    });
    expect(allowed.status).toBe(200);
    expect(Buffer.from(await allowed.arrayBuffer())).toEqual(test.bytes);
    // The same digest can be read through another actual readable comment binding.
    new ProjectRegistryRepository(test.database).registerCanvasInternal({
      workspaceId: test.workspaceA,
      projectId: "project-a",
      canvasId: "public",
      packageDir: test.directory,
      visibility: "shared",
      ownerHumanPrincipalId: "human-owner-1"
    });
    const at = new Date().toISOString();
    new CommentRepository(test.database, test.workspaceA).insertUnlocked({
      commentId: "public-download",
      projectId: "project-a",
      workItem: { kind: "task", canvasId: "public", taskId: "T-001" },
      authorHumanPrincipalId: "human-owner-1",
      body: "public",
      bodyFormat: "markdown",
      revision: 1,
      createdAt: at,
      updatedAt: at,
      attachments: []
    });
    test.attachmentService.bindCommentAttachments({
      actor: {
        humanPrincipalId: "human-owner-1",
        displayName: "Owner",
        deviceCredentialId: "device",
        projectId: "project-a",
        role: "owner",
        membershipId: "membership"
      },
      workspaceId: test.workspaceA,
      projectId: "project-a",
      commentId: "public-download",
      attachments: [
        {
          pendingUploadId: test.pendingId,
          digestSha256: test.digest,
          sizeBytes: test.bytes.length,
          mediaType: "text/plain",
          createdAt: at
        }
      ]
    });
    const digestRead = await fetch(`${base}/by-digest/${test.digest}`, { headers: auth(member) });
    expect(digestRead.status).toBe(200);
    expect(Buffer.from(await digestRead.arrayBuffer())).toEqual(test.bytes);
  });
});

describe("composed attachment read lifecycle", () => {
  it("separates legacy pending metadata from digest grants after a real schema upgrade", async () => {
    const boundBytes = Buffer.from("historical bound bytes");
    const unboundBytes = Buffer.from("historical independent bytes");
    let uploader!: { token: string; principalId: string };
    let boundDigest!: string;
    let unboundDigest!: string;
    const fixture = await setupCommentReadComposition({
      async prepareLegacy({ database, directory, projectId, owner }) {
        const identity = new HumanIdentityRepository(database);
        const invitation = identity.createInvitation({
          projectId,
          createdByHumanPrincipalId: owner.principalId
        });
        const joined = identity.consumeInvitation({
          invitationToken: invitation.invitationToken,
          projectId,
          displayName: "Legacy uploader"
        });
        uploader = { token: joined.deviceToken, principalId: joined.principal.humanPrincipalId };
        const blobs = new CommentAttachmentBlobStore(database, directory);
        const at = new Date().toISOString();
        const expiresAt = new Date(Date.now() + 3600000).toISOString();
        for (const [pendingId, bytes, status] of [
          ["legacy-bound-pending", boundBytes, "uploaded"],
          ["legacy-unbound-pending", unboundBytes, "finalized"]
        ] as const) {
          const digest = createHash("sha256").update(bytes).digest("hex");
          await blobs.put({
            expectedSha256: digest,
            expectedSizeBytes: bytes.length,
            mediaType: "text/plain",
            chunks: (async function* () {
              yield bytes;
            })()
          });
          database
            .prepare(`INSERT INTO comment_pending_uploads(
            pending_upload_id,workspace_id,project_id,uploader_human_principal_id,
            expected_size_bytes,media_type,file_name,status,digest_sha256,created_at,expires_at,
            uploaded_at,finalized_at
          ) VALUES(?,?,?,?,?,'text/plain','legacy-private-name.txt',?,?,?,?,?,?)`)
            .run(
              pendingId,
              owner.workspaceId,
              projectId,
              uploader.principalId,
              bytes.length,
              status,
              digest,
              at,
              expiresAt,
              at,
              status === "finalized" ? at : null
            );
          if (status === "uploaded") boundDigest = digest;
          else unboundDigest = digest;
        }
        new CommentRepository(database, owner.workspaceId).insertUnlocked({
          commentId: "legacy-comment",
          projectId,
          workItem: { kind: "task", canvasId: "default", taskId: "T-001" },
          authorHumanPrincipalId: owner.principalId,
          body: "historical comment",
          bodyFormat: "markdown",
          revision: 1,
          createdAt: at,
          updatedAt: at,
          attachments: []
        });
        database
          .prepare(`INSERT INTO comment_attachment_bindings(
          workspace_id,project_id,comment_id,digest_sha256,size_bytes,media_type,file_name,created_at
        ) VALUES(?,?,'legacy-comment',?,?,'text/plain','bound-public-name.txt',?)`)
          .run(owner.workspaceId, projectId, boundDigest, boundBytes.length, at);
      }
    });
    const { owner } = fixture;
    const viewer = await inviteAndJoin(
      fixture.origin,
      owner.token,
      fixture.projectId,
      "Legacy viewer"
    );
    const viewerRow = fixture.database
      .prepare("SELECT human_principal_id FROM workspace_device_sessions WHERE credential_sha256=?")
      .get(hashHumanToken(viewer)) as { human_principal_id: string };
    const download = (path: string, token: string) =>
      fetch(`${fixture.base}/attachments/${path}`, { headers: auth(token) });
    const open = vi.spyOn(CommentAttachmentBlobStore.prototype, "openRead");
    const denied = async (path: string, token: string) => {
      open.mockClear();
      const response = await download(path, token);
      expect.soft(response.status).toBe(403);
      expect
        .soft(await response.text())
        .toBe(JSON.stringify({ error: "attachment_auth_forbidden" }));
      expect.soft(response.headers.get("content-disposition")).toBeNull();
      expect.soft(open).not.toHaveBeenCalled();
    };
    for (const path of ["pending/legacy-bound-pending", `by-digest/${boundDigest}`]) {
      await denied(path, uploader.token);
    }
    await fixture.mutateAccess(owner.token, owner.workspaceId, "default", {
      operation: "grant",
      expectedAclRevision: 0,
      humanPrincipalId: viewerRow.human_principal_id,
      role: "viewer"
    });
    const readable = await download(`by-digest/${boundDigest}`, viewer);
    expect(readable.status).toBe(200);
    expect(Buffer.from(await readable.arrayBuffer())).toEqual(boundBytes);
    expect(readable.headers.get("content-disposition")).not.toContain("legacy-private-name");
    await denied("pending/legacy-bound-pending", viewer);
    await fixture.mutateAccess(owner.token, owner.workspaceId, "default", {
      operation: "grant",
      expectedAclRevision: 1,
      humanPrincipalId: uploader.principalId,
      role: "viewer"
    });
    const ownPending = await download("pending/legacy-bound-pending", uploader.token);
    expect(ownPending.status).toBe(200);
    expect(Buffer.from(await ownPending.arrayBuffer())).toEqual(boundBytes);
    expect(ownPending.headers.get("content-disposition")).toContain("legacy-private-name.txt");
    for (const [token, principalId, expectedAclRevision] of [
      [viewer, viewerRow.human_principal_id, 2],
      [uploader.token, uploader.principalId, 3]
    ] as const) {
      const grant = fixture.access.listActiveCanvasPersonGrants({
        workspaceId: owner.workspaceId,
        projectId: fixture.projectId,
        canvasId: "default",
        humanPrincipalId: principalId
      })[0]!;
      await fixture.mutateAccess(owner.token, owner.workspaceId, "default", {
        operation: "revoke",
        expectedAclRevision,
        grantId: grant.grantId
      });
      await denied(`by-digest/${boundDigest}`, token);
      await denied("pending/legacy-bound-pending", token);
    }
    for (const path of ["pending/legacy-unbound-pending", `by-digest/${unboundDigest}`]) {
      const response = await download(path, uploader.token);
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(unboundBytes);
      await denied(path, viewer);
    }
  });

  it.each([
    { reader: "uploader", status: "uploaded" },
    { reader: "unrelated viewer", status: "uploaded" },
    { reader: "uploader", status: "finalized" },
    { reader: "unrelated viewer", status: "finalized" }
  ] as const)("isolates an independent $status upload from an existing digest binding for $reader", async ({
    reader,
    status
  }) => {
    const fixture = await setupCommentReadComposition();
    const { owner } = fixture;
    const uploader = await inviteAndJoin(
      fixture.origin,
      owner.token,
      fixture.projectId,
      "Independent uploader"
    );
    const viewer = await inviteAndJoin(
      fixture.origin,
      owner.token,
      fixture.projectId,
      "Bound comment viewer"
    );
    const viewerPrincipal = fixture.database
      .prepare("SELECT human_principal_id FROM workspace_device_sessions WHERE credential_sha256=?")
      .get(hashHumanToken(viewer)) as { human_principal_id: string };
    const bytes = Buffer.from("same bytes, independent upload");
    const bound = await fixture.stage(owner.token, bytes);
    const comment = await fixture.createComment(owner.token, "default", "private", [bound]);
    await fixture.mutateAccess(owner.token, owner.workspaceId, "default", {
      operation: "grant",
      expectedAclRevision: 0,
      humanPrincipalId: viewerPrincipal.human_principal_id,
      role: "viewer"
    });
    const fileName = "independent-staged.txt";
    const created = await createPending(fixture.origin, uploader, fixture.projectId, {
      expectedSizeBytes: bytes.length,
      mediaType: "text/plain",
      fileName,
      expectedDigestSha256: bound.digestSha256
    });
    expect(created.response.status).toBe(201);
    const pendingId = created.payload.pendingUploadId as string;
    const uploaded = await uploadPending(
      fixture.origin,
      uploader,
      fixture.projectId,
      pendingId,
      bytes,
      "text/plain",
      bound.digestSha256
    );
    expect(uploaded.response.status).toBe(201);
    expect(uploaded.payload.status).toBe("uploaded");
    if (status === "finalized") {
      const finalized = await finalizePending(
        fixture.origin,
        uploader,
        fixture.projectId,
        pendingId,
        bound.digestSha256
      );
      expect(finalized.response.status).toBe(200);
    }
    const base = `${fixture.base}/attachments`;
    if (reader === "uploader") {
      for (const path of [`pending/${pendingId}`, `by-digest/${bound.digestSha256}`]) {
        const response = await fetch(`${base}/${path}`, { headers: auth(uploader) });
        expect.soft(response.status, path).toBe(200);
        expect.soft(Buffer.from(await response.arrayBuffer()), path).toEqual(bytes);
      }
    } else {
      const readable = await fetch(`${base}/comments/${comment.commentId}/${bound.digestSha256}`, {
        headers: auth(viewer)
      });
      expect(readable.status).toBe(200);
      expect(Buffer.from(await readable.arrayBuffer())).toEqual(bytes);
      const open = vi.spyOn(CommentAttachmentBlobStore.prototype, "openRead");
      const denied = await fetch(`${base}/pending/${pendingId}`, { headers: auth(viewer) });
      expect.soft(denied.status).toBe(403);
      const body = await denied.text();
      expect.soft(body).toBe(JSON.stringify({ error: "attachment_auth_forbidden" }));
      expect.soft(body).not.toContain(fileName);
      expect.soft(denied.headers.get("content-disposition")).toBeNull();
      expect(open).not.toHaveBeenCalled();
    }
  });

  it("uses the exact reused pending bindings after revoking the uploader's grants", async () => {
    const fixture = await setupCommentReadComposition();
    const { owner } = fixture;
    const uploader = await inviteAndJoin(
      fixture.origin,
      owner.token,
      fixture.projectId,
      "Uploader"
    );
    const principal = fixture.database
      .prepare("SELECT human_principal_id FROM workspace_device_sessions WHERE credential_sha256=?")
      .get(hashHumanToken(uploader)) as { human_principal_id: string };
    for (const canvasId of ["default", "other"]) {
      await fixture.mutateAccess(owner.token, owner.workspaceId, canvasId, {
        operation: "grant",
        expectedAclRevision: 0,
        humanPrincipalId: principal.human_principal_id,
        role: "editor"
      });
    }
    const bytes = Buffer.from("reused pending bytes");
    const attachment = await fixture.stage(uploader, bytes);
    await fixture.createComment(uploader, "default", "first", [attachment]);
    await fixture.createComment(uploader, "other", "second", [attachment]);
    const paths = [`pending/${attachment.pendingUploadId}`, `by-digest/${attachment.digestSha256}`];
    const download = (path: string) =>
      fetch(`${fixture.base}/attachments/${path}`, { headers: auth(uploader) });
    const revoke = async (canvasId: string) => {
      const grant = fixture.access.listActiveCanvasPersonGrants({
        workspaceId: owner.workspaceId,
        projectId: fixture.projectId,
        canvasId,
        humanPrincipalId: principal.human_principal_id
      })[0]!;
      await fixture.mutateAccess(owner.token, owner.workspaceId, canvasId, {
        operation: "revoke",
        expectedAclRevision: 1,
        grantId: grant.grantId
      });
    };
    await revoke("default");
    for (const path of paths) {
      const response = await download(path);
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    }
    await revoke("other");
    const open = vi.spyOn(CommentAttachmentBlobStore.prototype, "openRead");
    for (const path of paths) {
      const response = await download(path);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "attachment_auth_forbidden" });
    }
    expect(open).not.toHaveBeenCalled();
  });

  it("checks live multi-reference grants, staged ownership, workspace isolation and audit bytes", async () => {
    const fixture = await setupCommentReadComposition();
    const owner = fixture.owner;
    const member = await inviteAndJoin(
      fixture.origin,
      owner!.token,
      fixture.projectId,
      "Digest reader"
    );
    const otherOwner = fixture.createOtherWorkspace();
    const row = fixture.database
      .prepare("SELECT human_principal_id FROM workspace_device_sessions WHERE credential_sha256=?")
      .get(hashHumanToken(member)) as { human_principal_id: string };
    const bytes = Buffer.from([0, 255, 13, 10, 128, 42]);
    const attachment = await fixture.stage(owner!.token, bytes);
    const base = `${fixture.base}/attachments`;
    const nativeOpen = CommentAttachmentBlobStore.prototype.openRead;
    const open = vi.spyOn(CommentAttachmentBlobStore.prototype, "openRead");
    const download = (path: string, token = member) =>
      fetch(`${base}/${path}`, { headers: auth(token) });
    for (const path of [
      `pending/${attachment.pendingUploadId}`,
      `by-digest/${attachment.digestSha256}`
    ]) {
      const allowed = await download(path, owner!.token);
      expect(allowed.status).toBe(200);
      expect(Buffer.from(await allowed.arrayBuffer())).toEqual(bytes);
      open.mockClear();
      const denied = await download(path);
      expect(denied.status).toBe(403);
      expect(await denied.json()).toEqual({ error: "attachment_auth_forbidden" });
      expect(open).not.toHaveBeenCalled();
    }
    const first = await fixture.createComment(owner!.token, "default", "private-one", [attachment]);
    const secondUpload = await fixture.stage(owner!.token, bytes);
    const second = await fixture.createComment(owner!.token, "other", "private-two", [
      secondUpload
    ]);
    const paths = [
      `comments/${first.commentId}/${attachment.digestSha256}`,
      `comments/${second.commentId}/${attachment.digestSha256}`,
      `by-digest/${attachment.digestSha256}`,
      `pending/${attachment.pendingUploadId}`
    ];
    open.mockClear();
    for (const path of paths) {
      const denied = await download(path);
      expect(denied.status).toBe(403);
      expect(await denied.json()).toEqual({ error: "attachment_auth_forbidden" });
    }
    expect(open).not.toHaveBeenCalled();
    for (const path of paths) {
      const denied = await download(path, otherOwner!.token);
      expect(denied.status).toBe(404);
      expect(JSON.stringify(await denied.json())).not.toContain("private-evidence");
    }
    expect(open).not.toHaveBeenCalled();
    await fixture.mutateAccess(owner!.token, owner!.workspaceId, "other", {
      operation: "grant",
      expectedAclRevision: 0,
      humanPrincipalId: row.human_principal_id,
      role: "viewer"
    });
    const tombstone = await fetch(`${fixture.base}/comments/${second.commentId}/tombstone`, {
      method: "POST",
      headers: { ...auth(owner!.token), "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: 1, reason: "audit" })
    });
    expect(tombstone.status).toBe(200);
    expect(await tombstone.json()).toMatchObject({ body: null, tombstoned: true });
    for (const path of [
      `comments/${second.commentId}/${attachment.digestSha256}`,
      `by-digest/${attachment.digestSha256}`
    ]) {
      const allowed = await download(path);
      expect(allowed.status).toBe(200);
      const received = Buffer.from(await allowed.arrayBuffer());
      expect(received).toEqual(bytes);
      expect(createHash("sha256").update(received).digest("hex")).toBe(attachment.digestSha256);
    }
    open.mockClear();
    const stillPrivate = await download(`comments/${first.commentId}/${attachment.digestSha256}`);
    expect(stillPrivate.status).toBe(403);
    await stillPrivate.json();
    expect(open).not.toHaveBeenCalled();
    const grant = fixture.access.listActiveCanvasPersonGrants({
      workspaceId: owner!.workspaceId,
      projectId: fixture.projectId,
      canvasId: "other",
      humanPrincipalId: row.human_principal_id
    })[0]!;
    // Authorization is linearized before the asynchronous blob open. Revoke at that boundary.
    open.mockImplementationOnce(async function (this: CommentAttachmentBlobStore, digest) {
      await fixture.mutateAccess(owner!.token, owner!.workspaceId, "other", {
        operation: "revoke",
        expectedAclRevision: 1,
        grantId: grant.grantId
      });
      return nativeOpen.call(this, digest);
    });
    const admitted = await download(`by-digest/${attachment.digestSha256}`);
    expect(admitted.status).toBe(200);
    expect(Buffer.from(await admitted.arrayBuffer())).toEqual(bytes);
    open.mockClear();
    for (const path of paths) {
      const denied = await download(path);
      expect(denied.status).toBe(403);
      expect(await denied.json()).toEqual({ error: "attachment_auth_forbidden" });
    }
    expect(open).not.toHaveBeenCalled();
    // The same digest exists in a different Workspace, but does not re-authorize this member.
    const otherUpload = await fixture.stage(otherOwner!.token, bytes);
    const otherComment = await fixture.createComment(
      otherOwner!.token,
      "other",
      "other-workspace",
      [otherUpload]
    );
    const otherRead = await download(
      `comments/${otherComment.commentId}/${attachment.digestSha256}`,
      otherOwner!.token
    );
    expect(otherRead.status).toBe(200);
    expect(Buffer.from(await otherRead.arrayBuffer())).toEqual(bytes);
    open.mockClear();
    const denied = await download(`by-digest/${attachment.digestSha256}`);
    expect(denied.status).toBe(403);
    await denied.json();
    expect(open).not.toHaveBeenCalled();
  });
});
