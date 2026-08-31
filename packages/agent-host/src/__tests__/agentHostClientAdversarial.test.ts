import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  exampleExecutionEnvelopeInput,
  executionEnvelopeSchema,
  hashExecutionEnvelope,
  hostEventSchema,
  hostHelloSchema,
  mailboxDeliverySchema,
  serverEventSchema,
  type HostEvent
} from "@planweave-ai/agent-host-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import type { AgentHostExecutor } from "../execution/agentHostExecutor.js";
import { openAgentHostState } from "../state/agentHostState.js";
import { AgentHostClient } from "../transport/agentHostClient.js";
import { remoteRunnerEventV2Request } from "./support/remoteRunnerEventCapabilityTestValues.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  await Promise.all(
    cleanups
      .splice(0)
      .reverse()
      .map((cleanup) => cleanup())
  );
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("Agent Host adversarial executor failure", () => {
  it("maps a 20KB private error to a durable safe terminal event", async () => {
    const directory = await mkdtemp(join(tmpdir(), "planweave-agent-host-adversarial-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const state = await openAgentHostState(join(directory, "host.sqlite"));
    cleanups.push(() => state.close());
    const failed = deferred<Extract<HostEvent, { type: "dispatch.failed" }>>();
    const protocolFailure = deferred<unknown>();
    const secret = "token=host-secret-value";
    const privatePath = "/Users/private/worktree/plan.md";
    const envelope = executionEnvelopeSchema.parse({
      ...exampleExecutionEnvelopeInput,
      execution: { dispatchId: "dispatch-adversarial", attemptId: "attempt-adversarial" },
      projectId: "project-adversarial",
      taskId: "T-001",
      blockRef: "T-001#B-001",
      workspaceId: "workspace-client"
    });
    const delivery = mailboxDeliverySchema.parse({
      type: "mailbox.message",
      protocolVersion: 1,
      sequence: 1,
      previousSequence: 0,
      messageId: "mailbox-adversarial",
      command: {
        type: "execute_block",
        protocolVersion: 1,
        dispatchId: envelope.execution.dispatchId,
        leaseId: "lease-adversarial",
        executionAttemptId: envelope.execution.attemptId,
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        envelopeDigest: hashExecutionEnvelope(envelope),
        envelope
      }
    });
    const httpServer = createServer();
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => httpServer.close(() => resolve())));
    const webSocketServer = new WebSocketServer({ server: httpServer });
    cleanups.push(() => new Promise<void>((resolve) => webSocketServer.close(() => resolve())));
    webSocketServer.on("connection", (socket) => {
      socket.on("message", (data) => {
        try {
          const raw = JSON.parse(data.toString());
          if (raw.type === "host.hello") {
            hostHelloSchema.parse(raw);
            socket.send(
              JSON.stringify(
                serverEventSchema.parse({
                  type: "host.welcome",
                  protocolVersion: 1,
                  serverTime: new Date().toISOString(),
                  heartbeatIntervalMs: 60_000,
                  leaseDurationMs: 60_000
                })
              )
            );
            socket.send(JSON.stringify(delivery));
            return;
          }
          const event = hostEventSchema.parse(raw);
          if (event.type === "dispatch.failed") failed.resolve(event);
        } catch (error) {
          protocolFailure.reject(error);
        }
      });
    });
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("expected_http_port");
    const executor: AgentHostExecutor = {
      execute: async () => {
        throw new Error(`${privatePath} ${secret} ${"x".repeat(20_000)}`);
      }
    };
    const client = new AgentHostClient({
      serverUrl: `http://127.0.0.1:${address.port}`,
      hostId: "host-adversarial",
      workspaceId: "workspace-client",
      token: "host-token",
      capabilities: ["test"],
      capacity: 1,
      state,
      executor,
      request: remoteRunnerEventV2Request,
      allowInsecureTransport: true
    });
    cleanups.push(() => client.stop());
    client.start();

    const wireEvent = await Promise.race([failed.promise, protocolFailure.promise]);
    expect(wireEvent).toMatchObject({
      failure: {
        code: "executor_failed",
        message: "The Agent Host executor failed.",
        retryable: false
      }
    });
    expect(JSON.stringify(wireEvent)).not.toContain(secret);
    expect(JSON.stringify(wireEvent)).not.toContain(privatePath);
    expect(state.pendingEvents().find((event) => event.type === "dispatch.failed")).toEqual(
      wireEvent
    );
    expect(state.pendingExecutions(1)).toEqual([]);
  });
});
