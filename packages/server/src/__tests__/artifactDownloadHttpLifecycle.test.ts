import { createHash } from "node:crypto";
import type { ReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupArtifactDownloadHttp } from "./support/artifactDownloadHttpFixture.js";
import { CommentRepository } from "../comments/repository.js";
import {
  auth,
  bootstrap,
  createPending,
  finalizePending,
  setup as setupAttachments,
  uploadPending
} from "./support/commentAttachmentHttpFixture.js";

type DownloadKind =
  | "artifact"
  | "runtime_artifact"
  | "read_pending"
  | "read_digest"
  | "read_comment_attachment";
type DownloadMode = "complete" | "cancel" | "source_error" | "both_fail";
type SourceObservation = {
  stream: ReadStream;
  closed: Promise<void>;
  responseClosed: Promise<void>;
};

let isolatedHome: string;
beforeEach(async () => {
  isolatedHome = await mkdtemp(join(tmpdir(), "pw-download-home-"));
  vi.stubEnv("PLANWEAVE_HOME", isolatedHome);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(isolatedHome, { recursive: true, force: true });
});

function observeResponses(server: Server): () => Promise<void> {
  let latest: Promise<void> | undefined;
  server.on("request", (_request, response) => {
    latest = new Promise<void>((resolve) => response.once("close", resolve));
  });
  return () => {
    if (!latest) throw new Error("native_response_observation_required");
    return latest;
  };
}

function observeSource(
  stream: ReadStream,
  observations: SourceObservation[],
  responseClosed: Promise<void>
): void {
  const closed = new Promise<void>((resolve) => stream.once("close", resolve));
  observations.push({ stream, closed, responseClosed });
}

async function withDeadline<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 2_000);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function releaseSources(observations: SourceObservation[]): Promise<void> {
  for (const observation of observations) {
    observation.stream.destroy();
    await withDeadline(observation.closed, "cleanup_native_file_close_timeout");
  }
}

async function setupDownload(kind: DownloadKind) {
  const bytes = Buffer.alloc(8 * 1024 * 1024, "a");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const observations: SourceObservation[] = [];
  if (kind === "artifact" || kind === "runtime_artifact") {
    const fixture = await setupArtifactDownloadHttp(bytes);
    const responseClosed = observeResponses(fixture.server);
    const openRead = fixture.artifacts.openRead.bind(fixture.artifacts);
    vi.spyOn(fixture.artifacts, "openRead").mockImplementation(async (ref) => {
      const opened = await openRead(ref);
      observeSource(opened.stream, observations, responseClosed());
      return opened;
    });
    return {
      bytes,
      sha256,
      observations,
      url: kind === "artifact" ? fixture.artifactUrl : fixture.runtimeUrl,
      headers: kind === "artifact" ? fixture.artifactHeaders : fixture.runtimeHeaders,
      retained: () => fixture.artifacts.read(fixture.metadata.ref),
      handlerErrors: fixture.handlerErrors,
      runtime: fixture
    };
  }
  const fixture = await setupAttachments();
  const token = await bootstrap(fixture.origin);
  const created = await createPending(fixture.origin, token, "project-a", {
    expectedSizeBytes: bytes.length,
    mediaType: "text/plain",
    expectedDigestSha256: sha256,
    fileName: "download.txt"
  });
  expect(created.response.status).toBe(201);
  const pendingId = String(created.payload.pendingUploadId);
  const uploaded = await uploadPending(
    fixture.origin,
    token,
    "project-a",
    pendingId,
    bytes,
    "text/plain",
    sha256
  );
  expect(uploaded.response.status).toBe(201);
  expect(
    (await finalizePending(fixture.origin, token, "project-a", pendingId, sha256)).response.status
  ).toBe(200);
  const at = new Date().toISOString();
  new CommentRepository(fixture.database, fixture.workspaceA).insertUnlocked({
    commentId: "download-comment",
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
    commentId: "download-comment",
    attachments: [
      {
        pendingUploadId: pendingId,
        digestSha256: sha256,
        sizeBytes: bytes.length,
        mediaType: "text/plain",
        fileName: "download.txt",
        createdAt: new Date().toISOString()
      }
    ]
  });
  const responseClosed = observeResponses(fixture.server);
  const openRead = fixture.blobs.openRead.bind(fixture.blobs);
  vi.spyOn(fixture.blobs, "openRead").mockImplementation(async (digest) => {
    const opened = await openRead(digest);
    observeSource(opened.stream, observations, responseClosed());
    return opened;
  });
  const suffix =
    kind === "read_pending"
      ? `pending/${pendingId}`
      : kind === "read_digest"
        ? `by-digest/${sha256}`
        : `comments/download-comment/${sha256}`;
  return {
    bytes,
    sha256,
    observations,
    url: `${fixture.origin}/api/v1/projects/project-a/attachments/${suffix}`,
    headers: auth(token),
    retained: () => fixture.blobs.read(sha256),
    handlerErrors: [],
    runtime: undefined
  };
}

async function download(
  fixture: Awaited<ReturnType<typeof setupDownload>>,
  mode: DownloadMode,
  headers = fixture.headers
): Promise<{ status: number; headers: IncomingHttpHeaders; bytes: Buffer; complete: boolean }> {
  return withDeadline(
    new Promise((resolve, reject) => {
      const request = httpRequest(fixture.url, { headers, agent: false }, (response) => {
        const chunks: Buffer[] = [];
        let receivedFirst = false;
        response.on("data", (chunk: Buffer) => {
          chunks.push(Buffer.from(chunk));
          if (mode === "complete" || receivedFirst) return;
          receivedFirst = true;
          const observation = fixture.observations.at(-1);
          if (!observation) {
            reject(new Error("native_download_source_not_observed"));
            return;
          }
          expect(typeof observation.stream.fd).toBe("number");
          if (mode === "source_error" || mode === "both_fail") {
            observation.stream.destroy(new Error("native_download_injected_read_failure"));
          }
          if (mode === "cancel" || mode === "both_fail") {
            if (!response.socket) {
              reject(new Error("native_download_client_socket_required"));
              return;
            }
            response.socket.destroy();
          }
        });
        response.on("error", (error) => {
          if (mode === "complete") reject(error);
        });
        response.on("close", () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            bytes: Buffer.concat(chunks),
            complete: response.complete
          });
        });
      });
      request.on("error", reject);
      request.end();
    }),
    "native_http_download_timeout"
  );
}

async function expectFileClosed(observation: SourceObservation, complete: boolean): Promise<void> {
  await withDeadline(observation.closed, "native_file_close_timeout");
  expect(observation.stream.closed).toBe(true);
  expect(observation.stream.destroyed).toBe(true);
  expect(observation.stream.fd).toBe(null);
  expect(observation.stream.readableEnded).toBe(complete);
  await withDeadline(observation.responseClosed, "native_response_close_timeout");
  for (const event of ["error", "close", "end", "data"])
    expect(observation.stream.listenerCount(event)).toBe(0);
}

function expectSuccessfulDownload(
  result: Awaited<ReturnType<typeof download>>,
  fixture: Awaited<ReturnType<typeof setupDownload>>,
  kind: DownloadKind
): void {
  expect(result.status).toBe(200);
  expect(result.complete).toBe(true);
  expect(result.bytes.length).toBe(fixture.bytes.length);
  expect(createHash("sha256").update(result.bytes).digest("hex")).toBe(fixture.sha256);
  expect(result.headers["content-length"]).toBe(String(fixture.bytes.length));
  expect(result.headers["content-type"]).toBe("text/plain");
  expect(result.headers.etag).toBe(`"sha256:${fixture.sha256}"`);
  if (kind === "artifact" || kind === "runtime_artifact") {
    expect(result.headers["cache-control"]).toBe("private, immutable");
  } else {
    expect(result.headers["cache-control"]).toBe("private, no-store");
    expect(result.headers["content-disposition"]).toBe(
      `attachment; filename="${kind === "read_digest" ? "attachment" : "download.txt"}"; filename*=UTF-8''${kind === "read_digest" ? "attachment" : "download.txt"}`
    );
    expect(result.headers["x-content-type-options"]).toBe("nosniff");
    expect(result.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(result.headers["x-frame-options"]).toBe("DENY");
  }
}

const kinds: DownloadKind[] = [
  "artifact",
  "runtime_artifact",
  "read_pending",
  "read_digest",
  "read_comment_attachment"
];
describe("native HTTP download resource and authorization contracts", () => {
  it.each(
    kinds
  )("retains %s bytes across EOF, client cancellation, source failure, and simultaneous failure", async (kind) => {
    const fixture = await setupDownload(kind);
    try {
      for (const mode of ["cancel", "source_error", "both_fail"] as const) {
        const partial = await download(fixture, mode);
        expect(partial.status).toBe(200);
        expect(partial.complete).toBe(false);
        expect(partial.bytes.length).toBeGreaterThan(0);
        expect(partial.bytes.length).toBeLessThan(fixture.bytes.length);
        const source = fixture.observations.at(-1);
        if (!source) throw new Error("expected_partial_source");
        await expectFileClosed(source, false);
        expect(source.stream.bytesRead).toBeLessThan(fixture.bytes.length);
        const healthy = await download(fixture, "complete");
        expectSuccessfulDownload(healthy, fixture, kind);
        const healthySource = fixture.observations.at(-1);
        if (!healthySource) throw new Error("expected_healthy_source");
        await expectFileClosed(healthySource, true);
      }
      expect(
        createHash("sha256")
          .update(await fixture.retained())
          .digest("hex")
      ).toBe(fixture.sha256);
      expect(fixture.handlerErrors).toEqual([]);
      const beforeDenial = fixture.observations.length;
      const forbidden = await download(fixture, "complete", {
        ...fixture.headers,
        Authorization: "Bearer invalid-token"
      });
      expect(forbidden.status).toBe(401);
      expect(fixture.observations.length).toBe(beforeDenial);
    } finally {
      await releaseSources(fixture.observations);
    }
  });

  it("denies mismatched runtime grants and inactive leases without opening files", async () => {
    const fixture = await setupDownload("runtime_artifact");
    if (!fixture.runtime) throw new Error("runtime_fixture_required");
    try {
      const invalidGrant = await download(fixture, "complete", {
        ...fixture.headers,
        "x-planweave-runtime-artifact-grant-id": `runtime-artifact-${"0".repeat(64)}`
      });
      expect(invalidGrant.status).toBe(403);
      expect(fixture.observations).toHaveLength(0);
      fixture.runtime.deactivateRuntimeLease();
      const inactiveLease = await download(fixture, "complete");
      expect(inactiveLease.status).toBe(403);
      expect(fixture.observations).toHaveLength(0);
    } finally {
      await releaseSources(fixture.observations);
    }
  });

  it("closes a native file before returning HTTP 409 on runtime metadata mismatch", async () => {
    const fixture = await setupDownload("runtime_artifact");
    if (!fixture.runtime) throw new Error("runtime_fixture_required");
    try {
      const grant = fixture.runtime.grants.createDownloadGrant({
        ...fixture.runtime.grantInput,
        operationId: "mismatched-media",
        mediaType: "application/json"
      });
      const rejected = await download(fixture, "complete", {
        ...fixture.headers,
        "x-planweave-runtime-artifact-grant-id": grant.grantId
      });
      expect(rejected.status).toBe(409);
      expect(JSON.parse(rejected.bytes.toString())).toEqual({
        error: "runtime_artifact_integrity_mismatch"
      });
      expect(fixture.observations).toHaveLength(1);
      const source = fixture.observations[0];
      await expectFileClosed(source, false);
      expect(source.stream.bytesRead).toBe(0);
      expectSuccessfulDownload(await download(fixture, "complete"), fixture, "runtime_artifact");
      expect(fixture.runtime.handlerErrors).toEqual([]);
    } finally {
      await releaseSources(fixture.observations);
    }
  });
});
