import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { exampleHumanDeviceToken } from "@planweave-ai/collaboration-protocol/fixtures/collaboration";
import {
  remoteActionViewSchema,
  remoteDispatchIntentV3Schema,
  remoteEndpointOperationObservationSchema,
  remoteEventReplaySchema,
  remoteHumanExecutionActionCommandSchema,
  remoteOperationObservationSchema
} from "@planweave-ai/collaboration-protocol/remote-run";
import { CollaborationClient } from "../main/collaboration/index.js";

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

async function listen(handler: Handler): Promise<{
  origin: string;
  close: () => Promise<void>;
}> {
  const server = createServer((req, res) => {
    void Promise.resolve(handler(req, res)).catch(() => {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: "test_handler_failed" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${address.port}/`,
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

describe("CollaborationClient remote operations process integration", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const close = cleanups.pop();
      if (close) await close();
    }
  });

  it("observes remote operations and replays events through process-level HTTP fixture", async () => {
    const observation = remoteOperationObservationSchema.parse({
      operationId: "op-process-1",
      projectId: "project-demo-001",
      canvasId: "default",
      blockRef: "T-1#B-1",
      state: "running",
      dispatchId: "dispatch-process-1",
      executionAttemptId: "attempt-process-1",
      createdAt: "2030-01-01T00:00:00.000Z",
      updatedAt: "2030-01-01T00:01:00.000Z",
      attempt: {
        executionAttemptId: "attempt-process-1",
        dispatchId: "dispatch-process-1",
        status: "running",
        hostId: "host-1",
        leaseId: "lease-1",
        leaseExpiresAt: "2030-01-01T01:00:00.000Z",
        stateVersion: 1
      },
      dispatchStatus: "running",
      runtime: { ref: "T-1#B-1", status: "in_progress" }
    });
    const dispatchCommand = remoteDispatchIntentV3Schema.parse({
      schemaVersion: "remote-run/v3",
      projectId: "project-demo-001",
      canvasId: "default",
      blockRef: "T-1#B-1",
      agentEndpointId: "endpoint-process-1",
      idempotencyKey: "idem-process-1",
      expectedResponsibilityRevision: 2,
      expectedReviewerRevision: 3,
      executionTargetRevision: 4,
      contentRevision: "7",
      graphFingerprint: `pkg-${"a".repeat(64)}`
    });
    const dispatchedObservation = remoteEndpointOperationObservationSchema.parse({
      ...observation,
      attempt: {
        executionAttemptId: "attempt-process-1",
        dispatchId: "dispatch-process-1",
        status: "running",
        leaseId: "lease-1",
        leaseExpiresAt: "2030-01-01T01:00:00.000Z",
        stateVersion: 1
      },
      agentEndpoint: {
        schemaVersion: "agent-endpoint/v1",
        endpointId: "endpoint-process-1",
        profileId: "codex-acp",
        agentId: "codex",
        displayName: "Codex",
        hostDisplayName: "Process Fixture Host",
        capabilities: ["acp.codex"],
        status: "available",
        resolvedAt: "2030-01-01T00:00:00.000Z"
      }
    });
    const eventReplay = remoteEventReplaySchema.parse({
      eventProtocolVersion: 1,
      executionAttemptId: "attempt-process-1",
      afterCursor: 0,
      cursor: 1,
      highWatermark: 1,
      hasMore: false,
      events: [{ cursor: 1, kind: "agent_message", text: "process fixture" }]
    });
    const actionCommand = remoteHumanExecutionActionCommandSchema.parse({
      kind: "cancel",
      actionId: "action-1",
      operationId: "op-process-1",
      dispatchId: "dispatch-process-1",
      executionAttemptId: "attempt-process-1",
      expectedAttemptVersion: 1,
      leaseId: "lease-1",
      reason: "process fixture cancel"
    });
    const actionView = remoteActionViewSchema.parse({
      request: actionCommand,
      state: "recorded",
      createdAt: "2030-01-01T00:02:00.000Z"
    });
    const fixture = await listen(async (req, res) => {
      expect(req.headers.authorization).toBe(`Bearer ${exampleHumanDeviceToken}`);
      const url = req.url ?? "";
      if (req.method === "GET" && url.includes("/remote-operations/op-process-1/events")) {
        json(res, 200, eventReplay);
        return;
      }
      if (req.method === "GET" && url.includes("/remote-operations/op-process-1")) {
        json(res, 200, observation);
        return;
      }
      if (req.method === "POST" && url.endsWith("/remote-operations")) {
        const body = remoteDispatchIntentV3Schema.parse(
          JSON.parse((await readBody(req)).toString("utf8"))
        );
        expect(body).toEqual(dispatchCommand);
        json(res, 202, dispatchedObservation);
        return;
      }
      if (req.method === "POST" && url.includes("/actions")) {
        const body = remoteHumanExecutionActionCommandSchema.parse(
          JSON.parse((await readBody(req)).toString("utf8"))
        );
        expect(body).toEqual(actionCommand);
        json(res, 200, actionView);
        return;
      }
      json(res, 404, { error: "not_found" });
    });
    cleanups.push(fixture.close);

    const client = new CollaborationClient({
      profile: {
        profileId: "profile-test",
        displayName: "Test",
        serverBaseUrl: fixture.origin,
        projectId: "project-demo-001",
        allowInsecureTransport: true,
        endpoint: {
          topology: "loopback_http",
          serverOrigin: fixture.origin,
          allowedClientOrigins: [fixture.origin],
          tlsTrust: "not_applicable"
        }
      },
      credential: { getDeviceToken: () => exampleHumanDeviceToken },
      limits: {
        requestTimeoutMs: 2_000,
        jsonBodyMaxBytes: 4_096,
        observerMaxPayloadBytes: 4_096,
        reconnectInitialDelayMs: 10,
        reconnectMaxDelayMs: 20
      }
    });

    const observed = await client.observeRemoteOperation("op-process-1");
    expect(observed.operationId).toBe("op-process-1");
    expect(observed.attempt.leaseId).toBe("lease-1");

    const events = await client.replayRemoteOperationEvents("op-process-1", { afterCursor: 0 });
    expect(events.events[0]).toMatchObject({ cursor: 1, kind: "agent_message" });

    const dispatched = await client.dispatchRemoteOperation(dispatchCommand);
    expect(dispatched.dispatchId).toBe("dispatch-process-1");
    expect(dispatched.agentEndpoint?.endpointId).toBe("endpoint-process-1");
    expect(dispatched.attempt.hostId).toBeUndefined();

    const action = await client.executeRemoteOperationAction("op-process-1", actionCommand);
    expect(action.state).toBe("recorded");
    client.dispose();
  });
});
