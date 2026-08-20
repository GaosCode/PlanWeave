import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, WebSocket } from "ws";
import {
  exampleAssignmentProjection,
  exampleBootstrapResponse,
  exampleHumanDeviceToken,
  exampleMemberPage,
  exampleObserverCatchupRequired,
  exampleObserverEvent,
  exampleObserverWelcome,
  exampleSecretsForRedaction
} from "@planweave-ai/collaboration-protocol/fixtures/collaboration";
import { accessCapabilityFlags } from "@planweave-ai/collaboration-protocol/access/control";
import {
  CONTENT_VERSION_MAX_TOTAL_BYTES,
  HUMAN_OBSERVER_PROTOCOL_VERSION
} from "@planweave-ai/collaboration-protocol/core/limits";
import { contentVersionTransferMediaType } from "@planweave-ai/collaboration-protocol/content/transfer";
import {
  CollaborationClient,
  CollaborationClientError,
  redactCollaborationText
} from "../main/collaboration/index.js";

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

async function listen(handler: Handler): Promise<{
  server: Server;
  origin: string;
  close: () => Promise<void>;
}> {
  const server = createServer((req, res) => {
    void Promise.resolve(handler(req, res)).catch(() => {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: "test_handler_failed" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${address.port}/`;
  return {
    server,
    origin,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": bytes.byteLength
  });
  res.end(bytes);
}

const transferScope = {
  workspaceId: "workspace-demo-001",
  projectId: "project-demo-001",
  canvasId: "canvas-demo-001"
};
const transferDigest = "a".repeat(64);
const transferRef = {
  versionId: `version-${transferDigest}`,
  canonicalDigest: transferDigest,
  verification: "complete" as const
};
const transferMembers = [
  { kind: "desktop_layout" as const, path: "desktop/layout.json", content: "{}" },
  { kind: "manifest" as const, path: "manifest.json", content: "{}" }
].map((member) => ({
  ...member,
  digestSha256: createHash("sha256").update(member.content, "utf8").digest("hex"),
  sizeBytes: Buffer.byteLength(member.content, "utf8")
}));

function transferHeader(overrides: Record<string, unknown> = {}) {
  return {
    type: "header",
    schemaVersion: "content-version/v1",
    scope: transferScope,
    completed: transferRef,
    canonicalDigest: transferDigest,
    totalBytes: transferMembers.reduce((total, member) => total + member.sizeBytes, 0),
    memberCount: transferMembers.length,
    createdAt: "2026-08-01T00:00:00.000Z",
    createdBy: { kind: "human", id: "owner" },
    ...overrides
  };
}

function ndjson(res: ServerResponse, frames: unknown[], end = true): void {
  res.writeHead(200, { "content-type": `${contentVersionTransferMediaType}; charset=utf-8` });
  for (const frame of frames) res.write(`${JSON.stringify(frame)}\n`);
  if (end) res.end();
}

describe("CollaborationClient", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) {
      const close = cleanups.pop();
      if (close) await close();
    }
  });

  function clientFor(
    origin: string,
    overrides: {
      token?: string | undefined;
      limits?: ConstructorParameters<typeof CollaborationClient>[0]["limits"];
      WebSocketImpl?: ConstructorParameters<typeof CollaborationClient>[0]["WebSocketImpl"];
    } = {}
  ) {
    return new CollaborationClient({
      profile: {
        profileId: "profile-test",
        displayName: "Test",
        serverBaseUrl: origin,
        projectId: "project-demo-001",
        allowInsecureTransport: true,
        endpoint: {
          topology: "loopback_http",
          serverOrigin: origin,
          allowedClientOrigins: [origin],
          tlsTrust: "not_applicable"
        }
      },
      credential: {
        getDeviceToken: () => overrides.token
      },
      limits: {
        requestTimeoutMs: 2_000,
        jsonBodyMaxBytes: 4_096,
        observerMaxPayloadBytes: 4_096,
        reconnectInitialDelayMs: 10,
        reconnectMaxDelayMs: 20,
        ...overrides.limits
      },
      WebSocketImpl: overrides.WebSocketImpl,
      random: () => 0
    });
  }

  it("rejects oversized content transfer headers before accumulating members", async () => {
    const fixture = await listen((_req, res) => {
      ndjson(res, [transferHeader({ totalBytes: CONTENT_VERSION_MAX_TOTAL_BYTES + 1 })]);
    });
    cleanups.push(fixture.close);
    const client = clientFor(fixture.origin, { token: exampleHumanDeviceToken });
    await expect(
      client.fetchContentVersion({ scope: transferScope, content: transferRef })
    ).rejects.toMatchObject({ code: "content_transfer_frame_schema_invalid" });
    client.dispose();
  });

  it("rejects oversized transfer error bodies without a declared length", async () => {
    const fixture = await listen((_req, res) => {
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      res.end("x".repeat(4_097));
    });
    cleanups.push(fixture.close);
    const client = clientFor(fixture.origin, { token: exampleHumanDeviceToken });
    await expect(
      client.fetchContentVersion({ scope: transferScope, content: transferRef })
    ).rejects.toMatchObject({ code: "collaboration_response_too_large" });
    client.dispose();
  });

  it("rejects transfer media types that only share the expected prefix", async () => {
    const fixture = await listen((_req, res) => {
      res.writeHead(200, { "content-type": `${contentVersionTransferMediaType}-evil` });
      res.end();
    });
    cleanups.push(fixture.close);
    const client = clientFor(fixture.origin, { token: exampleHumanDeviceToken });
    await expect(
      client.fetchContentVersion({ scope: transferScope, content: transferRef })
    ).rejects.toMatchObject({ code: "content_transfer_media_type_invalid" });
    client.dispose();
  });

  it("fails closed for malformed content transfer order, digest, scope, and unterminated frames", async () => {
    const cases = [
      {
        name: "member before header",
        frames: [{ type: "member", index: 0, member: transferMembers[0] }],
        end: true,
        code: "content_transfer_header_missing"
      },
      {
        name: "wrong digest",
        frames: [
          transferHeader(),
          {
            type: "member",
            index: 0,
            member: { ...transferMembers[0], digestSha256: "b".repeat(64) }
          }
        ],
        end: true,
        code: "content_transfer_member_digest_invalid"
      },
      {
        name: "wrong workspace",
        frames: [transferHeader({ scope: { ...transferScope, workspaceId: "workspace-other" } })],
        end: true,
        code: "content_transfer_authority_mismatch"
      },
      {
        name: "cumulative bytes exceed declared total",
        frames: [
          transferHeader({ totalBytes: 4, memberCount: 3 }),
          { type: "member", index: 0, member: transferMembers[0] },
          { type: "member", index: 1, member: transferMembers[1] },
          {
            type: "member",
            index: 2,
            member: {
              kind: "task_prompt",
              path: "nodes/T-001/prompt.md",
              content: "abc",
              digestSha256: createHash("sha256").update("abc", "utf8").digest("hex"),
              sizeBytes: 3
            }
          }
        ],
        end: true,
        code: "content_transfer_total_bytes_invalid"
      },
      {
        name: "unterminated",
        frames: [],
        end: false,
        code: "content_transfer_frame_unterminated"
      }
    ] as const;
    for (const testCase of cases) {
      const fixture = await listen((_req, res) => {
        if (testCase.name === "unterminated") {
          res.writeHead(200, {
            "content-type": `${contentVersionTransferMediaType}; charset=utf-8`
          });
          res.end(JSON.stringify(transferHeader()));
          return;
        }
        ndjson(res, [...testCase.frames], testCase.end);
      });
      cleanups.push(fixture.close);
      const client = clientFor(fixture.origin, { token: exampleHumanDeviceToken });
      await expect(
        client.fetchContentVersion({ scope: transferScope, content: transferRef })
      ).rejects.toMatchObject({ code: testCase.code });
      client.dispose();
    }
  });

  it("keeps the stream deadline active until content transfer body consumption completes", async () => {
    const fixture = await listen((_req, res) => {
      ndjson(res, [transferHeader()], false);
    });
    cleanups.push(fixture.close);
    const client = clientFor(fixture.origin, {
      token: exampleHumanDeviceToken,
      limits: { requestTimeoutMs: 25 }
    });
    await expect(
      client.fetchContentVersion({ scope: transferScope, content: transferRef })
    ).rejects.toMatchObject({ code: "collaboration_timeout" });
    client.dispose();
  });

  it("lists members through application-shaped methods and validates responses", async () => {
    const fixture = await listen(async (req, res) => {
      expect(req.headers.authorization).toBe(`Bearer ${exampleHumanDeviceToken}`);
      expect(req.url).toContain("/human/members");
      json(res, 200, exampleMemberPage);
    });
    cleanups.push(fixture.close);
    const client = clientFor(fixture.origin, { token: exampleHumanDeviceToken });
    const page = await client.listMembers({ cursor: 0, limit: 50 });
    expect(page.items[0]?.role).toBe("owner");
    client.dispose();
  });

  it("updates the authenticated human display name through the strict profile route", async () => {
    const fixture = await listen(async (req, res) => {
      expect(req.method).toBe("PATCH");
      expect(req.url).toBe("/api/v1/projects/project-demo-001/human/me");
      expect(req.headers.authorization).toBe(`Bearer ${exampleHumanDeviceToken}`);
      expect(JSON.parse((await readBody(req)).toString("utf8"))).toEqual({
        displayName: "Ada Lovelace"
      });
      json(res, 200, {
        humanPrincipalId: "human-owner-001",
        displayName: "Ada Lovelace",
        createdAt: "2030-01-01T00:00:00.000Z"
      });
    });
    cleanups.push(fixture.close);
    const client = clientFor(fixture.origin, { token: exampleHumanDeviceToken });

    await expect(client.updateOwnDisplayName({ displayName: "  Ada Lovelace  " })).resolves.toEqual(
      {
        humanPrincipalId: "human-owner-001",
        displayName: "Ada Lovelace",
        createdAt: "2030-01-01T00:00:00.000Z"
      }
    );
    client.dispose();
  });

  it("reads a comment attachment with device authentication", async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const digestSha256 = createHash("sha256").update(bytes).digest("hex");
    const fixture = await listen((req, res) => {
      expect(req.method).toBe("GET");
      expect(req.url).toBe(
        `/api/v1/projects/project-demo-001/attachments/comments/comment-1/${digestSha256}`
      );
      expect(req.headers.authorization).toBe(`Bearer ${exampleHumanDeviceToken}`);
      res.writeHead(200, {
        "content-type": "image/png",
        "content-length": bytes.byteLength
      });
      res.end(bytes);
    });
    cleanups.push(fixture.close);
    const client = clientFor(fixture.origin, { token: exampleHumanDeviceToken });

    await expect(client.readCommentAttachment("comment-1", digestSha256)).resolves.toEqual({
      digestSha256,
      mediaType: "image/png",
      sizeBytes: bytes.byteLength,
      bodyBase64: bytes.toString("base64")
    });
    client.dispose();
  });

  it("rejects a comment attachment whose body does not match the requested digest", async () => {
    const requestedDigest = "a".repeat(64);
    const fixture = await listen((_req, res) => {
      const bytes = Buffer.from("different attachment body");
      res.writeHead(200, {
        "content-type": "image/png",
        "content-length": bytes.byteLength
      });
      res.end(bytes);
    });
    cleanups.push(fixture.close);
    const client = clientFor(fixture.origin, { token: exampleHumanDeviceToken });

    await expect(client.readCommentAttachment("comment-1", requestedDigest)).rejects.toMatchObject({
      code: "collaboration_attachment_digest_mismatch"
    });
    client.dispose();
  });

  it("reads the redacted canvas runtime status with device authentication", async () => {
    const projection = {
      schemaVersion: "canvas-runtime-status/v2",
      scope: {
        workspaceId: "workspace-demo-001",
        projectId: "project-demo-001",
        canvasId: "canvas-demo-001"
      },
      packageFingerprint: `pkg-${"a".repeat(64)}`,
      capturedAt: "2026-08-01T00:00:00.000Z",
      tasks: [{ taskId: "T-001", status: "implemented", openFeedbackCount: 0 }],
      blocks: []
    };
    const fixture = await listen((req, res) => {
      expect(req.method).toBe("GET");
      expect(req.headers.authorization).toBe(`Bearer ${exampleHumanDeviceToken}`);
      expect(req.url).toBe(
        "/api/v1/projects/project-demo-001/canvases/canvas-demo-001/runtime-status"
      );
      json(res, 200, projection);
    });
    cleanups.push(fixture.close);
    const client = clientFor(fixture.origin, { token: exampleHumanDeviceToken });

    await expect(client.readRuntimeStatus("canvas-demo-001")).resolves.toEqual(projection);
    client.dispose();
  });

  it("reads both strict runtime availability branches from the dedicated endpoint", async () => {
    const status = {
      schemaVersion: "canvas-runtime-status/v2" as const,
      scope: {
        workspaceId: "workspace-demo-001",
        projectId: "project-demo-001",
        canvasId: "canvas-available"
      },
      packageFingerprint: `pkg-${"a".repeat(64)}`,
      capturedAt: "2026-08-20T00:00:00.000Z",
      tasks: [],
      blocks: []
    };
    const fixture = await listen((req, res) => {
      expect(req.method).toBe("GET");
      expect(req.headers.authorization).toBe(`Bearer ${exampleHumanDeviceToken}`);
      if (req.url?.endsWith("/canvas-available/runtime-availability")) {
        json(res, 200, {
          schemaVersion: "canvas-runtime-availability/v1",
          kind: "available",
          status,
          sourceRevision: "src-revision-001",
          graphFingerprint: `pkg-${"b".repeat(64)}`
        });
        return;
      }
      expect(req.url).toBe(
        "/api/v1/projects/project-demo-001/canvases/canvas-detached/runtime-availability"
      );
      json(res, 200, {
        schemaVersion: "canvas-runtime-availability/v1",
        kind: "unavailable",
        reason: "runtime_not_attached"
      });
    });
    cleanups.push(fixture.close);
    const client = clientFor(fixture.origin, { token: exampleHumanDeviceToken });

    await expect(client.readRuntimeAvailability("canvas-available")).resolves.toMatchObject({
      kind: "available",
      status
    });
    await expect(client.readRuntimeAvailability("canvas-detached")).resolves.toEqual({
      schemaVersion: "canvas-runtime-availability/v1",
      kind: "unavailable",
      reason: "runtime_not_attached"
    });
    client.dispose();
  });

  it("rejects an invalid runtime availability response instead of mapping it to unavailable", async () => {
    const fixture = await listen((_req, res) => {
      json(res, 200, {
        schemaVersion: "canvas-runtime-availability/v1",
        kind: "unavailable"
      });
    });
    cleanups.push(fixture.close);
    const client = clientFor(fixture.origin, { token: exampleHumanDeviceToken });

    await expect(client.readRuntimeAvailability("canvas-invalid")).rejects.toBeInstanceOf(Error);
    client.dispose();
  });

  it("uses device-authenticated current-canvas access transport and preserves CAS conflicts", async () => {
    const scope = {
      scopeKind: "canvas" as const,
      workspaceId: "workspace-demo-001",
      projectId: "project-demo-001",
      canvasId: "canvas-demo-001"
    };
    const accessView = {
      scope,
      projectVisibility: "shared" as const,
      canvasVisibility: "private" as const,
      projectAclRevision: 7,
      canvasAclRevision: 7,
      project: {
        scope: { ...scope, scopeKind: "project" as const, canvasId: null },
        aclRevision: 7,
        effectiveRole: "owner" as const,
        roleSource: "scope_owner" as const,
        capabilities: accessCapabilityFlags("owner"),
        disabledReason: null
      },
      canvas: {
        scope,
        aclRevision: 7,
        effectiveRole: "owner" as const,
        roleSource: "scope_owner" as const,
        capabilities: accessCapabilityFlags("owner"),
        disabledReason: null
      },
      people: [
        {
          humanPrincipalId: "human-owner-001",
          displayName: "Owner",
          membership: "active" as const,
          effectiveRole: "owner" as const,
          capabilities: accessCapabilityFlags("owner"),
          disabledReason: null,
          grants: []
        }
      ]
    };
    let postBody: unknown = null;
    const fixture = await listen(async (req, res) => {
      expect(req.headers.authorization).toBe(`Bearer ${exampleHumanDeviceToken}`);
      expect(req.url).toBe("/api/v1/projects/project-demo-001/canvases/canvas-demo-001/access");
      if (req.method === "GET") {
        json(res, 200, accessView);
        return;
      }
      postBody = JSON.parse((await readBody(req)).toString("utf8"));
      json(res, 409, { status: "conflict", reason: "acl_revision_conflict", aclRevision: 8 });
    });
    cleanups.push(fixture.close);
    const client = clientFor(fixture.origin, { token: exampleHumanDeviceToken });

    await expect(client.getCurrentCanvasAccess(scope.canvasId)).resolves.toEqual(accessView);
    await expect(
      client.mutateCurrentCanvasAccess({
        canvasId: scope.canvasId,
        request: {
          operation: "grant",
          scope,
          expectedAclRevision: 7,
          humanPrincipalId: "human-editor-001",
          role: "editor"
        }
      })
    ).resolves.toEqual({ status: "conflict", reason: "acl_revision_conflict", aclRevision: 8 });
    expect(postBody).toMatchObject({ operation: "grant", expectedAclRevision: 7, scope });
    client.dispose();
  });

  it("maps auth expiry HTTP responses to typed boundary errors", async () => {
    const fixture = await listen((_req, res) => {
      json(res, 401, { error: "human_auth_unauthenticated" });
    });
    cleanups.push(fixture.close);
    const client = clientFor(fixture.origin, { token: exampleHumanDeviceToken });
    await expect(client.listMembers()).rejects.toMatchObject({
      name: "CollaborationClientError",
      kind: "auth",
      code: "human_auth_unauthenticated",
      httpStatus: 401
    });
    client.dispose();
  });

  it("rejects malformed JSON responses", async () => {
    const fixture = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{not-json");
    });
    cleanups.push(fixture.close);
    const client = clientFor(fixture.origin, { token: exampleHumanDeviceToken });
    await expect(client.listMembers()).rejects.toMatchObject({
      kind: "protocol",
      code: "collaboration_malformed_json"
    });
    client.dispose();
  });

  it("rejects oversized responses", async () => {
    const fixture = await listen((_req, res) => {
      const payload = JSON.stringify({ items: [], nextCursor: null, pad: "x".repeat(8_000) });
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload)
      });
      res.end(payload);
    });
    cleanups.push(fixture.close);
    const client = clientFor(fixture.origin, {
      token: exampleHumanDeviceToken,
      limits: { jsonBodyMaxBytes: 1_024 }
    });
    await expect(client.listMembers()).rejects.toMatchObject({
      kind: "payload_too_large",
      code: "collaboration_response_too_large"
    });
    client.dispose();
  });

  it("reads valid pages above 16 KiB and fails closed above the response budget", async () => {
    const responseBudgetBytes = 4 * 1_024 * 1_024;
    const template = exampleMemberPage.items[0];
    if (!template) throw new Error("member fixture is empty");
    const largePage = {
      items: Array.from({ length: 100 }, (_, index) => ({
        ...template,
        membershipId: `membership-${String(index).padStart(3, "0")}`,
        humanPrincipalId: `human-owner-${String(index).padStart(3, "0")}`
      })),
      nextCursor: null
    };
    const largePayload = JSON.stringify(largePage);
    expect(Buffer.byteLength(largePayload)).toBeGreaterThan(16 * 1_024);
    expect(Buffer.byteLength(largePayload)).toBeLessThan(responseBudgetBytes);
    const oversizedPayload = JSON.stringify({
      ...largePage,
      pad: "x".repeat(responseBudgetBytes)
    });
    let requestCount = 0;
    const fixture = await listen((_req, res) => {
      requestCount += 1;
      if (requestCount === 1) {
        res.writeHead(200, {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(largePayload)
        });
        res.end(largePayload);
        return;
      }
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(oversizedPayload)
      });
      res.end(oversizedPayload);
    });
    cleanups.push(fixture.close);
    const client = clientFor(fixture.origin, {
      token: exampleHumanDeviceToken,
      limits: { jsonBodyMaxBytes: responseBudgetBytes }
    });
    await expect(client.listMembers({ limit: 100 })).resolves.toMatchObject({
      items: expect.any(Array),
      nextCursor: null
    });
    await expect(client.listMembers({ limit: 100 })).rejects.toMatchObject({
      kind: "payload_too_large",
      code: "collaboration_response_too_large"
    });
    client.dispose();
  });

  it("rejects schema-invalid assignment projections", async () => {
    const fixture = await listen((_req, res) => {
      json(res, 200, { ...exampleAssignmentProjection, revision: -1 });
    });
    cleanups.push(fixture.close);
    const client = clientFor(fixture.origin, { token: exampleHumanDeviceToken });
    await expect(
      client.getAssignment({ kind: "task", canvasId: "canvas-1", taskId: "task-1" })
    ).rejects.toMatchObject({
      kind: "protocol",
      code: "collaboration_response_invalid"
    });
    client.dispose();
  });

  it("maps conflict and rate-limit errors", async () => {
    let n = 0;
    const fixture = await listen((_req, res) => {
      n += 1;
      if (n === 1) json(res, 409, { error: "work_revision_conflict" });
      else {
        res.setHeader("retry-after", "2");
        json(res, 429, { error: "human_rate_limited" });
      }
    });
    cleanups.push(fixture.close);
    const client = clientFor(fixture.origin, { token: exampleHumanDeviceToken });
    await expect(
      client.updateAssignment({
        workItem: { kind: "task", canvasId: "canvas-1", taskId: "task-1" },
        target: { kind: "unassigned" },
        expectedRevision: 1
      })
    ).rejects.toMatchObject({ kind: "conflict", code: "work_revision_conflict" });
    await expect(client.listMembers()).rejects.toMatchObject({
      kind: "rate_limited",
      retryable: true,
      retryAfterMs: 2_000
    });
    client.dispose();
  });

  it("aborts in-flight requests on dispose", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = await listen(async (_req, res) => {
      await gate;
      json(res, 200, exampleMemberPage);
    });
    cleanups.push(fixture.close);
    const client = clientFor(fixture.origin, { token: exampleHumanDeviceToken });
    const pending = client.listMembers();
    client.dispose();
    await expect(pending).rejects.toBeInstanceOf(CollaborationClientError);
    release();
  });

  it("bootstraps without Authorization and redacts secrets in logs", async () => {
    const fixture = await listen(async (req, res) => {
      expect(req.headers.authorization).toBeUndefined();
      const body = JSON.parse((await readBody(req)).toString("utf8"));
      expect(body.displayName).toBe("Owner");
      json(res, 201, exampleBootstrapResponse);
    });
    cleanups.push(fixture.close);
    const client = clientFor(fixture.origin, { token: undefined });
    const result = await client.bootstrapOwner({ displayName: "Owner" });
    expect(result.deviceToken).toBe(exampleHumanDeviceToken);
    expect(redactCollaborationText(exampleSecretsForRedaction.authorizationHeader)).toBe(
      "Bearer [REDACTED]"
    );
    expect(redactCollaborationText(JSON.stringify(result))).not.toContain(exampleHumanDeviceToken);
    client.dispose();
  });

  it("subscribes to human observer, advances cursor, and handles catch-up", async () => {
    const http = await listen((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    cleanups.push(http.close);

    const wss = new WebSocketServer({ noServer: true });
    cleanups.push(
      () =>
        new Promise((resolve, reject) => {
          wss.close((error) => (error ? reject(error) : resolve()));
        })
    );

    http.server.on("upgrade", (request, socket, head) => {
      if (!request.url?.includes("/human/observe")) {
        socket.destroy();
        return;
      }
      expect(request.headers.origin).toBe(new URL(http.origin).origin);
      wss.handleUpgrade(request, socket, head, (ws) => {
        ws.on("message", (raw) => {
          const message = JSON.parse(String(raw));
          expect(message.type).toBe("human.observer.hello");
          expect(message.lastCursor).toBe(0);
          ws.send(JSON.stringify(exampleObserverWelcome));
          ws.send(JSON.stringify(exampleObserverEvent));
          ws.send(JSON.stringify(exampleObserverCatchupRequired));
        });
      });
    });

    const events: string[] = [];
    const statuses: string[] = [];
    const client = clientFor(http.origin, {
      token: exampleHumanDeviceToken,
      WebSocketImpl: WebSocket as unknown as ConstructorParameters<
        typeof CollaborationClient
      >[0]["WebSocketImpl"]
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("observer timeout")), 3_000);
      client.startObserver({
        onEvent: (event) => {
          events.push(event.kind);
        },
        onCatchupRequired: (message) => {
          events.push(message.reason);
          expect(client.lastObserverCursor()).toBe(100);
          clearTimeout(timer);
          resolve();
        },
        onStatus: (status) => {
          statuses.push(status.state);
        }
      });
    });

    expect(events).toEqual(["assignment", "retention_gap"]);
    expect(statuses).toContain("connected");
    expect(statuses).toContain("catching_up");
    client.dispose();
  });

  it("reconnects observer after socket close and preserves cursor", async () => {
    const http = await listen((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    cleanups.push(http.close);
    const wss = new WebSocketServer({ noServer: true });
    cleanups.push(
      () =>
        new Promise((resolve, reject) => {
          wss.close((error) => (error ? reject(error) : resolve()));
        })
    );

    let connections = 0;
    http.server.on("upgrade", (request, socket, head) => {
      wss.handleUpgrade(request, socket, head, (ws) => {
        connections += 1;
        if (connections === 1) {
          ws.send(
            JSON.stringify({
              type: "human.observer.welcome",
              protocolVersion: HUMAN_OBSERVER_PROTOCOL_VERSION,
              projectId: "project-demo-001",
              serverTime: "2030-01-01T00:00:00.000Z",
              cursor: 5
            })
          );
          setTimeout(() => ws.close(4002, "forced"), 20);
        } else {
          ws.on("message", (raw) => {
            const hello = JSON.parse(String(raw));
            expect(hello.lastCursor).toBe(5);
            ws.send(
              JSON.stringify({
                type: "human.observer.welcome",
                protocolVersion: HUMAN_OBSERVER_PROTOCOL_VERSION,
                projectId: "project-demo-001",
                serverTime: "2030-01-01T00:00:01.000Z",
                cursor: 5
              })
            );
          });
        }
      });
    });

    const client = clientFor(http.origin, {
      token: exampleHumanDeviceToken,
      WebSocketImpl: WebSocket as unknown as ConstructorParameters<
        typeof CollaborationClient
      >[0]["WebSocketImpl"]
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("reconnect timeout")), 3_000);
      let sawReconnect = false;
      client.startObserver({
        onStatus: (status) => {
          if (status.state === "reconnecting") sawReconnect = true;
          if (status.state === "connected" && sawReconnect && connections >= 2) {
            clearTimeout(timer);
            resolve();
          }
        }
      });
    });

    expect(client.lastObserverCursor()).toBe(5);
    client.dispose();
  });

  it("retries an observer forbidden handshake after project access is granted", async () => {
    const http = await listen((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    cleanups.push(http.close);
    const wss = new WebSocketServer({ noServer: true });
    cleanups.push(
      () =>
        new Promise((resolve, reject) => {
          wss.close((error) => (error ? reject(error) : resolve()));
        })
    );

    let attempts = 0;
    http.server.on("upgrade", (request, socket, head) => {
      attempts += 1;
      if (attempts === 1) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        ws.on("message", () => {
          ws.send(
            JSON.stringify({
              type: "human.observer.welcome",
              protocolVersion: HUMAN_OBSERVER_PROTOCOL_VERSION,
              projectId: "project-demo-001",
              serverTime: "2030-01-01T00:00:00.000Z",
              cursor: 0
            })
          );
        });
      });
    });

    const client = clientFor(http.origin, {
      token: exampleHumanDeviceToken,
      WebSocketImpl: WebSocket as unknown as ConstructorParameters<
        typeof CollaborationClient
      >[0]["WebSocketImpl"]
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("observer authorization retry timeout")),
        3_000
      );
      client.startObserver({
        onStatus: (status) => {
          if (status.state === "connected") {
            clearTimeout(timer);
            resolve();
          }
        }
      });
    });

    expect(attempts).toBe(2);
    expect(client.observerState()).toMatchObject({ state: "connected", cursor: 0 });
    client.dispose();
  });

  it("keeps an immediate observer replacement when the stopped socket closes", async () => {
    const http = await listen((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    cleanups.push(http.close);
    const wss = new WebSocketServer({ noServer: true });
    cleanups.push(
      () =>
        new Promise((resolve, reject) => {
          wss.close((error) => (error ? reject(error) : resolve()));
        })
    );

    let connections = 0;
    let replacementCursor: unknown;
    http.server.on("upgrade", (_request, socket, head) => {
      wss.handleUpgrade(_request, socket, head, (ws) => {
        connections += 1;
        const connection = connections;
        ws.on("message", (raw) => {
          const hello = JSON.parse(String(raw));
          if (connection === 2) replacementCursor = hello.lastCursor;
          ws.send(
            JSON.stringify({
              type: "human.observer.welcome",
              protocolVersion: HUMAN_OBSERVER_PROTOCOL_VERSION,
              projectId: "project-demo-001",
              serverTime: "2030-01-01T00:00:00.000Z",
              cursor: 5
            })
          );
        });
      });
    });

    const client = clientFor(http.origin, {
      token: exampleHumanDeviceToken,
      WebSocketImpl: WebSocket as unknown as ConstructorParameters<
        typeof CollaborationClient
      >[0]["WebSocketImpl"]
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("initial observer timeout")), 3_000);
      client.startObserver({
        onStatus: (status) => {
          if (status.state === "connected") {
            clearTimeout(timer);
            resolve();
          }
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("replacement observer timeout")), 3_000);
      client.stopObserver();
      client.startObserver({
        onStatus: (status) => {
          if (status.state === "connected" && connections === 2) {
            clearTimeout(timer);
            resolve();
          }
        }
      });
    });

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(connections).toBe(2);
    expect(replacementCursor).toBe(5);
    expect(client.lastObserverCursor()).toBe(5);
    client.dispose();
  });

  it("rejects observer events that do not continue from the validated cursor", async () => {
    const http = await listen((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    cleanups.push(http.close);
    const wss = new WebSocketServer({ noServer: true });
    cleanups.push(
      () =>
        new Promise((resolve, reject) => {
          wss.close((error) => (error ? reject(error) : resolve()));
        })
    );

    const protocolClose = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("observer cursor validation timeout")),
        2_000
      );
      http.server.on("upgrade", (request, socket, head) => {
        wss.handleUpgrade(request, socket, head, (ws) => {
          ws.on("message", () => {
            ws.send(
              JSON.stringify({
                ...exampleObserverWelcome,
                cursor: 5
              })
            );
            ws.send(
              JSON.stringify({
                ...exampleObserverEvent,
                cursor: 7,
                previousCursor: 6
              })
            );
          });
          ws.on("close", (code) => {
            clearTimeout(timer);
            expect(code).toBe(4000);
            resolve();
          });
        });
      });
    });

    const onEvent = () => {
      throw new Error("discontinuous observer event must not be delivered");
    };
    const client = clientFor(http.origin, {
      token: exampleHumanDeviceToken,
      WebSocketImpl: WebSocket as unknown as ConstructorParameters<
        typeof CollaborationClient
      >[0]["WebSocketImpl"]
    });
    client.startObserver({ onEvent });

    await protocolClose;
    expect(client.lastObserverCursor()).toBe(5);
    client.dispose();
  });

  it("handles observer auth expiry without reconnect loop", async () => {
    const http = await listen((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    cleanups.push(http.close);
    const wss = new WebSocketServer({ noServer: true });
    cleanups.push(
      () =>
        new Promise((resolve, reject) => {
          wss.close((error) => (error ? reject(error) : resolve()));
        })
    );
    http.server.on("upgrade", (request, socket, head) => {
      wss.handleUpgrade(request, socket, head, (ws) => {
        ws.send(
          JSON.stringify({
            type: "human.observer.auth_expired",
            protocolVersion: HUMAN_OBSERVER_PROTOCOL_VERSION,
            code: "human_device_revoked"
          })
        );
      });
    });

    const client = clientFor(http.origin, {
      token: exampleHumanDeviceToken,
      WebSocketImpl: WebSocket as unknown as ConstructorParameters<
        typeof CollaborationClient
      >[0]["WebSocketImpl"]
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("auth expiry timeout")), 2_000);
      client.startObserver({
        onAuthExpired: (message) => {
          expect(message.code).toBe("human_device_revoked");
        },
        onStatus: (status) => {
          if (status.state === "auth_expired") {
            clearTimeout(timer);
            resolve();
          }
        }
      });
    });

    await new Promise((r) => setTimeout(r, 40));
    expect(client.observerState().state).toBe("auth_expired");
    client.dispose();
  });

  it("surfaces an authenticated observer handshake rejection instead of timing out", async () => {
    const http = await listen((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    cleanups.push(http.close);
    http.server.on("upgrade", (_request, socket) => {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    });

    const client = clientFor(http.origin, {
      token: exampleHumanDeviceToken,
      WebSocketImpl: WebSocket as unknown as ConstructorParameters<
        typeof CollaborationClient
      >[0]["WebSocketImpl"]
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("handshake rejection timeout")), 500);
      client.startObserver({
        onStatus: (status) => {
          if (status.state === "auth_expired") {
            clearTimeout(timer);
            expect(status.code).toBe("collaboration_observer_http_401");
            resolve();
          }
        }
      });
    });

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(client.observerState()).toEqual({
      state: "auth_expired",
      code: "collaboration_observer_http_401"
    });
    client.dispose();
  });

  it("does not expose raw request(path) or socket accessors", () => {
    const client = clientFor("http://127.0.0.1:9/", { token: exampleHumanDeviceToken });
    expect("request" in client).toBe(false);
    expect("socket" in client).toBe(false);
    client.dispose();
  });
});
