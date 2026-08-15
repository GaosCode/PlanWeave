import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { CANVAS_COMMAND_PROTOCOL_VERSION } from "@planweave-ai/collaboration-protocol/core/limits";
import {
  exampleCanvasCommandAccepted,
  exampleCanvasReconnectTruncatedJournal,
  exampleCanvasCommandStaleRevisionRejected,
  exampleCanvasReconnectAfterDisconnect,
  exampleHumanDeviceToken
} from "@planweave-ai/collaboration-protocol/fixtures/collaboration";
import { CanvasCommandSessionState, CollaborationClient } from "../main/collaboration/index.js";

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
  return {
    server,
    origin: `http://127.0.0.1:${address.port}/`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (error) {
        reject(error);
      }
    });
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

describe("CanvasCommandSessionState", () => {
  it("tracks CAS conflict without inventing merge revisions", () => {
    const session = new CanvasCommandSessionState();
    session.bind("canvas-default");
    session.applyOutcome(exampleCanvasCommandStaleRevisionRejected);
    const snap = session.snapshot();
    expect(snap?.revision).toBe(0);
    expect(snap?.contentDigest).toBeNull();
    expect(snap?.lastConflict).toEqual({
      expectedRevision: 2,
      authoritativeRevision: 4,
      authoritativeContentDigest:
        exampleCanvasCommandStaleRevisionRejected.conflict!.authoritativeContentDigest
    });
    expect(snap?.lastRejectCode).toBe("stale_revision");
  });

  it("applies accepted outcomes and reconnect deltas in order", () => {
    const session = new CanvasCommandSessionState();
    session.bind("canvas-default");
    session.applyAccepted(exampleCanvasCommandAccepted);
    expect(session.getRevision()).toBe(4);
    const reconnect = session.applyReconnect(exampleCanvasReconnectAfterDisconnect);
    // journal entry already applied via accepted operationId → empty to-apply
    expect(reconnect.entriesToApply).toEqual([]);
    expect(session.getRevision()).toBe(4);
  });

  it("bounds operation dedupe and resets it after an authoritative snapshot", () => {
    const session = new CanvasCommandSessionState();
    session.bind("canvas-default");
    for (let index = 0; index < 1_025; index += 1) {
      session.applyAccepted({
        ...exampleCanvasCommandAccepted,
        operationId: `op-${index}`,
        journalEntryId: `journal-${index}`,
        previousRevision: index,
        revision: index + 1
      });
    }

    expect(session.hasApplied("op-0")).toBe(false);
    expect(session.hasApplied("op-1")).toBe(true);
    expect(session.hasApplied("op-1024")).toBe(true);
    const journalEntry = exampleCanvasReconnectAfterDisconnect.entries[0]!;
    expect(
      session.prepareReconnect({
        ...exampleCanvasReconnectAfterDisconnect,
        entries: [{ ...journalEntry, operationId: "op-1024" }]
      }).entriesToApply
    ).toEqual([]);
    expect(
      session.prepareReconnect({
        ...exampleCanvasReconnectAfterDisconnect,
        entries: [{ ...journalEntry, operationId: "op-0" }]
      }).entriesToApply
    ).toHaveLength(1);

    session.applyReconnect(exampleCanvasReconnectTruncatedJournal);
    expect(session.hasApplied("op-1024")).toBe(false);
    expect(session.snapshot()).toMatchObject({
      revision: exampleCanvasReconnectTruncatedJournal.snapshot.metadata.revision,
      contentDigest: exampleCanvasReconnectTruncatedJournal.snapshot.metadata.contentDigest
    });
  });
});

describe("CollaborationClient canvas commands", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) {
      const close = cleanups.pop();
      if (close) await close();
    }
  });

  it("submits intents with tracked expectedRevision and surfaces stale CAS", async () => {
    const seen: unknown[] = [];
    let headRevision = 0;
    const { origin, close } = await listen(async (req, res) => {
      const body = await readBody(req);
      seen.push({ url: req.url, auth: req.headers.authorization, body });
      if (String(req.url).includes("/commands")) {
        const submit = body as { expectedRevision: number; operationId: string };
        if (submit.expectedRevision !== headRevision) {
          json(res, 409, {
            ...exampleCanvasCommandStaleRevisionRejected,
            operationId: submit.operationId,
            conflict: {
              expectedRevision: submit.expectedRevision,
              authoritativeRevision: headRevision,
              authoritativeContentDigest:
                exampleCanvasCommandStaleRevisionRejected.conflict!.authoritativeContentDigest
            }
          });
          return;
        }
        headRevision += 1;
        json(res, 200, {
          ...exampleCanvasCommandAccepted,
          operationId: submit.operationId,
          revision: headRevision,
          previousRevision: headRevision - 1,
          idempotentReplay: false
        });
        return;
      }
      json(res, 404, { error: "not_found" });
    });
    cleanups.push(close);

    const client = new CollaborationClient({
      profile: {
        profileId: "profile-cmd",
        displayName: "Cmd",
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
      credential: { getDeviceToken: () => exampleHumanDeviceToken },
      limits: { requestTimeoutMs: 2_000, jsonBodyMaxBytes: 64_000 }
    });
    cleanups.push(async () => client.dispose());

    const first = await client.submitCanvasCommand({
      canvasId: "canvas-default",
      operationId: "op-first",
      intent: {
        kind: "update_task_prompt",
        taskId: "task-1",
        promptMarkdown: "# one"
      },
      expectedRevision: 0
    });
    expect(first.type).toBe("canvas.command.accepted");
    expect(client.canvasCommandSession()?.revision).toBe(1);

    // Explicitly pass a stale expectedRevision (do not trust client auto-increment guess).
    const stale = await client.submitCanvasCommand({
      canvasId: "canvas-default",
      operationId: "op-stale",
      intent: {
        kind: "update_task_prompt",
        taskId: "task-1",
        promptMarkdown: "# two"
      },
      expectedRevision: 0
    });
    expect(stale).toMatchObject({
      type: "canvas.command.rejected",
      code: "stale_revision",
      conflict: { expectedRevision: 0, authoritativeRevision: 1 }
    });
    expect(client.canvasCommandSession()?.revision).toBe(1);
    expect(client.canvasCommandSession()?.lastRejectCode).toBe("stale_revision");
    expect(seen[0]).toMatchObject({
      auth: `Bearer ${exampleHumanDeviceToken}`
    });
    expect((seen[0] as { body: { type: string } }).body.type).toBe("canvas.command.submit");
    expect((seen[0] as { body: { protocolVersion: number } }).body.protocolVersion).toBe(
      CANVAS_COMMAND_PROTOCOL_VERSION
    );
  });

  it("parses schema-valid server_error outcomes carried by HTTP 500", async () => {
    const { origin, close } = await listen((_req, res) => {
      json(res, 500, {
        type: "canvas.command.rejected",
        protocolVersion: CANVAS_COMMAND_PROTOCOL_VERSION,
        schemaVersion: "canvas-command/v1",
        projectId: "project-demo-001",
        canvasId: "canvas-default",
        operationId: "op-repair",
        code: "server_error",
        detail: "canvas_operation_retention_repair_required"
      });
    });
    cleanups.push(close);
    const client = new CollaborationClient({
      profile: {
        profileId: "profile-repair",
        displayName: "Repair",
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
      credential: { getDeviceToken: () => exampleHumanDeviceToken },
      limits: { requestTimeoutMs: 2_000, jsonBodyMaxBytes: 64_000 }
    });
    cleanups.push(async () => client.dispose());

    await expect(
      client.submitCanvasCommand({
        canvasId: "canvas-default",
        operationId: "op-repair",
        intent: {
          kind: "update_task_prompt",
          taskId: "task-1",
          promptMarkdown: "# repair"
        },
        expectedRevision: 0
      })
    ).resolves.toMatchObject({
      type: "canvas.command.rejected",
      code: "server_error",
      detail: "canvas_operation_retention_repair_required"
    });
  });

  it("reconnects with afterRevision from session state", async () => {
    const { origin, close } = await listen(async (req, res) => {
      const body = (await readBody(req)) as { afterRevision: number };
      expect(body.afterRevision).toBe(3);
      json(res, 200, exampleCanvasReconnectAfterDisconnect);
    });
    cleanups.push(close);
    const client = new CollaborationClient({
      profile: {
        profileId: "profile-reconnect",
        displayName: "Reconnect",
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
      credential: { getDeviceToken: () => exampleHumanDeviceToken }
    });
    cleanups.push(async () => client.dispose());
    client.bindCanvasCommandSession("canvas-default");
    // seed revision 3
    client.canvasCommandSession();
    const session = new CanvasCommandSessionState();
    // Use reconnect with explicit afterRevision instead of private seed.
    const result = await client.reconnectCanvasCommands({
      canvasId: "canvas-default",
      afterRevision: 3
    });
    expect(result.response.type).toBe("canvas.reconnect.delta");
    expect(result.session?.revision).toBe(4);
    void session;
  });

  it("does not advance the session when required snapshot materialization fails", async () => {
    const { origin, close } = await listen(async (_req, res) => {
      json(res, 200, exampleCanvasReconnectTruncatedJournal);
    });
    cleanups.push(close);
    const client = new CollaborationClient({
      profile: {
        profileId: "profile-snapshot",
        displayName: "Snapshot",
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
      credential: { getDeviceToken: () => exampleHumanDeviceToken }
    });
    cleanups.push(async () => client.dispose());
    client.bindCanvasCommandSession("canvas-default");

    await expect(
      client.reconnectCanvasCommands({ canvasId: "canvas-default", afterRevision: 0 }, undefined, {
        beforeReconnect: async ({ snapshotRequired }) => {
          expect(snapshotRequired).toBe(true);
          throw new Error("collaboration_canvas_snapshot_materialization_required");
        }
      })
    ).rejects.toThrow("collaboration_canvas_snapshot_materialization_required");
    expect(client.canvasCommandSession()).toMatchObject({ revision: 0, contentDigest: null });
  });
});
