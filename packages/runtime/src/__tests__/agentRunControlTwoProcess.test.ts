import { once } from "node:events";
import { lstat, mkdir, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentRunControlClient } from "../autoRun/agentRunControlClient.js";
import {
  AGENT_RUN_CONTROL_PROTOCOL_VERSION,
  agentRunControlCommandSchema,
  agentRunControlEndpointDescriptorSchema,
  agentRunControlResponseSchema,
  type AgentRunControlAction,
  type AgentRunControlCommand,
  type AgentRunControlResponse
} from "../autoRun/agentRunControlContract.js";
import { readAgentRunControlDescriptor } from "../autoRun/agentRunControlEndpoint.js";
import { AgentRunControlLocator } from "../autoRun/agentRunControlLocator.js";
import { executeDesktopAgentRunControl } from "../desktop/agentRunControlApi.js";
import { createTestWorkspace } from "./promptTestHelpers.js";
import {
  AgentRunControlOwnerProcess,
  type OwnerWorkerMessage
} from "./support/agentRunControlProcessHarness.js";

const roots: string[] = [];
const owners = new Set<AgentRunControlOwnerProcess>();
const originalHome = process.env.PLANWEAVE_HOME;
const originalSettings = process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
const testTimeoutMs = 15_000;
const operationTimeoutMs = 2_000;

type Fixture = Awaited<ReturnType<typeof applicationFixture>>;

async function applicationFixture(runId = "RUN-001") {
  const { root, home, init } = await createTestWorkspace();
  roots.push(root, home);
  const runDir = join(init.workspace.resultsDir, "T-001", "blocks", "B-001", "runs", runId);
  await mkdir(runDir, { recursive: true });
  const identity = {
    scope: runDir,
    executorRunId: runId,
    desktopRunId: "DESKTOP-RUN-001",
    runSessionId: "RUN-SESSION-001",
    claimRef: "T-001#B-001",
    sessionId: "acp-session-1"
  };
  return {
    root,
    runDir,
    recordId: `T-001#B-001::${runId}`,
    identity
  };
}

async function startOwner(fixture: Fixture) {
  const started = await AgentRunControlOwnerProcess.start(fixture.runDir, fixture.identity);
  owners.add(started.owner);
  if (started.descriptor.transport === "unix") roots.push(dirname(started.descriptor.address));
  return started;
}

function applicationAction(fixture: Fixture, action: AgentRunControlAction) {
  return executeDesktopAgentRunControl({
    ref: { projectRoot: fixture.root, canvasId: "default" },
    recordId: fixture.recordId,
    action
  });
}

function deliveryFor(action: string, requestId?: string) {
  return (message: OwnerWorkerMessage): boolean =>
    message.kind === "delivery" &&
    message.action === action &&
    (requestId === undefined || message.requestId === requestId);
}

function frame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const result = Buffer.alloc(4 + payload.byteLength);
  result.writeUInt32BE(payload.byteLength, 0);
  payload.copy(result, 4);
  return result;
}

function responseFrom(socket: Socket): Promise<AgentRunControlResponse> {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for framed response.")),
      operationTimeoutMs
    );
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.byteLength < 4) return;
      const length = buffered.readUInt32BE(0);
      if (buffered.byteLength < 4 + length) return;
      clearTimeout(timer);
      try {
        resolve(
          agentRunControlResponseSchema.parse(
            JSON.parse(buffered.subarray(4, 4 + length).toString("utf8")) as unknown
          )
        );
      } catch (error) {
        reject(error);
      } finally {
        socket.destroy();
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function rawRequest(
  descriptor: { address: string },
  value: unknown,
  splitAt?: number
): Promise<AgentRunControlResponse> {
  const socket = createConnection(descriptor.address);
  await once(socket, "connect");
  const response = responseFrom(socket);
  const encoded = frame(value);
  if (splitAt === undefined) {
    socket.write(encoded);
  } else {
    socket.write(encoded.subarray(0, splitAt));
    await new Promise<void>((resolve) => setImmediate(resolve));
    socket.write(encoded.subarray(splitAt));
  }
  return response;
}

function command(
  fixture: Fixture,
  descriptor: { leaseId: string },
  values: Pick<AgentRunControlCommand, "commandId" | "kind"> & Record<string, unknown>
): AgentRunControlCommand {
  return agentRunControlCommandSchema.parse({
    version: AGENT_RUN_CONTROL_PROTOCOL_VERSION,
    leaseId: descriptor.leaseId,
    identity: fixture.identity,
    ...values
  });
}

afterEach(async () => {
  await Promise.all([...owners].map((owner) => owner.terminate()));
  owners.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  if (originalHome === undefined) delete process.env.PLANWEAVE_HOME;
  else process.env.PLANWEAVE_HOME = originalHome;
  if (originalSettings === undefined) delete process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE;
  else process.env.PLANWEAVE_DESKTOP_SETTINGS_FILE = originalSettings;
});

describe("agent run control two-process integration", () => {
  it(
    "delivers application actions to a live owner and survives client reconstruction",
    async () => {
      const fixture = await applicationFixture();
      const { owner, descriptor } = await startOwner(fixture);

      const followUp = await applicationAction(fixture, {
        kind: "follow_up",
        identity: fixture.identity,
        prompt: "Continue with cross-process verification."
      });
      expect(followUp).toMatchObject({
        ok: true,
        acceptedAt: expect.any(String),
        result: { status: "delivered", deliveredAt: expect.any(String) }
      });
      if (!followUp.ok || followUp.result.status !== "delivered") {
        throw new Error("Expected an accepted and delivered follow-up receipt.");
      }
      expect(Date.parse(followUp.result.deliveredAt)).toBeGreaterThanOrEqual(
        Date.parse(followUp.acceptedAt)
      );
      await owner.waitFor(deliveryFor("follow_up"), "follow-up delivery");

      owner.send({ kind: "add_request", requestKind: "permission", requestId: "permission-allow" });
      await owner.waitFor(
        (message) => message.kind === "request_ready" && message.requestId === "permission-allow",
        "permission request"
      );
      const firstClient = new AgentRunControlClient(descriptor, { timeoutMs: 1000 });
      const allowCommand = agentRunControlCommandSchema.parse({
        version: AGENT_RUN_CONTROL_PROTOCOL_VERSION,
        commandId: globalThis.crypto.randomUUID(),
        leaseId: descriptor.leaseId,
        kind: "respond",
        identity: { ...fixture.identity, requestId: "permission-allow" },
        outcome: { kind: "select", optionId: "allow" }
      });
      await expect(firstClient.execute(allowCommand)).resolves.toMatchObject({
        ok: true,
        result: { status: "delivered" }
      });
      await owner.waitFor(deliveryFor("respond", "permission-allow"), "permission allow delivery");

      owner.send({ kind: "add_request", requestKind: "permission", requestId: "permission-deny" });
      await owner.waitFor(
        (message) => message.kind === "request_ready" && message.requestId === "permission-deny",
        "second permission request"
      );
      const persistedDescriptor = await readAgentRunControlDescriptor(fixture.runDir);
      expect(persistedDescriptor).toEqual(descriptor);
      if (!persistedDescriptor) throw new Error("Expected a persisted owner descriptor.");
      const rebuiltClient = new AgentRunControlClient(persistedDescriptor, { timeoutMs: 1000 });
      const denyCommand = agentRunControlCommandSchema.parse({
        ...allowCommand,
        commandId: globalThis.crypto.randomUUID(),
        identity: { ...fixture.identity, requestId: "permission-deny" },
        outcome: { kind: "select", optionId: "deny" }
      });
      await expect(rebuiltClient.execute(denyCommand)).resolves.toMatchObject({
        ok: true,
        result: { status: "delivered" }
      });
      const denied = await owner.waitFor(
        deliveryFor("respond", "permission-deny"),
        "permission deny delivery"
      );
      expect(denied.value).toBe("deny");

      owner.send({ kind: "add_request", requestKind: "permission", requestId: "permission-cancel" });
      await owner.waitFor(
        (message) => message.kind === "request_ready" && message.requestId === "permission-cancel",
        "cancelled permission request"
      );
      await expect(
        rebuiltClient.execute(
          agentRunControlCommandSchema.parse({
            ...allowCommand,
            commandId: globalThis.crypto.randomUUID(),
            identity: { ...fixture.identity, requestId: "permission-cancel" },
            outcome: { kind: "cancel" }
          })
        )
      ).resolves.toMatchObject({ ok: true, result: { status: "delivered" } });
      const permissionCancellation = await owner.waitFor(
        deliveryFor("reject", "permission-cancel"),
        "permission cancellation delivery"
      );
      expect(permissionCancellation.reason).toBe(
        "Permission request was cancelled through runner control."
      );

      owner.send({ kind: "add_request", requestKind: "elicitation", requestId: "elicitation-1" });
      await owner.waitFor(
        (message) => message.kind === "request_ready" && message.requestId === "elicitation-1",
        "elicitation request"
      );
      const elicitation = await applicationAction(fixture, {
        kind: "respond",
        identity: { ...fixture.identity, requestId: "elicitation-1" },
        outcome: { action: "accept", content: { answer: "verified" } }
      });
      expect(elicitation).toMatchObject({ ok: true, result: { status: "delivered" } });
      const elicited = await owner.waitFor(
        deliveryFor("respond", "elicitation-1"),
        "elicitation delivery"
      );
      expect(elicited.value).toEqual({ action: "accept", content: { answer: "verified" } });

      const cancelled = await applicationAction(fixture, {
        kind: "cancel",
        identity: fixture.identity
      });
      expect(cancelled).toMatchObject({ ok: true, result: { status: "delivered" } });
      await owner.stop();
      owners.delete(owner);
    },
    testTimeoutMs
  );

  it(
    "returns typed identity, pending, lease, capability, and inactive failures",
    async () => {
      const fixture = await applicationFixture();
      const { owner, descriptor } = await startOwner(fixture);

      await expect(
        applicationAction(fixture, {
          kind: "follow_up",
          identity: { ...fixture.identity, executorRunId: "RUN-FOREIGN" },
          prompt: "This must not be routed."
        })
      ).resolves.toMatchObject({ ok: false, code: "invalid_identity" });
      await expect(
        applicationAction(fixture, {
          kind: "follow_up",
          identity: { ...fixture.identity, sessionId: "foreign-session" },
          prompt: "This must not be delivered."
        })
      ).resolves.toMatchObject({ ok: false, code: "invalid_identity" });
      await expect(
        applicationAction(fixture, {
          kind: "respond",
          identity: { ...fixture.identity, requestId: "missing-request" },
          outcome: { kind: "select", optionId: "allow" }
        })
      ).resolves.toMatchObject({ ok: false, code: "request_not_pending" });

      const forgedDescriptor = agentRunControlEndpointDescriptorSchema.parse({
        ...descriptor,
        leaseId: globalThis.crypto.randomUUID()
      });
      const staleCommand = command(fixture, forgedDescriptor, {
        kind: "follow_up",
        commandId: globalThis.crypto.randomUUID(),
        prompt: "This stale lease must not be delivered."
      });
      await expect(
        new AgentRunControlClient(forgedDescriptor, { timeoutMs: 1000 }).execute(staleCommand)
      ).resolves.toMatchObject({ ok: false, code: "stale_lease" });

      owner.send({ kind: "capabilities", permission: false });
      await owner.waitFor(
        (message) =>
          message.kind === "capabilities_set" &&
          (message.capabilities as { permission?: unknown }).permission === false,
        "permission capability denial"
      );
      owner.send({ kind: "add_request", requestKind: "permission", requestId: "denied-request" });
      await owner.waitFor(
        (message) => message.kind === "request_ready" && message.requestId === "denied-request",
        "capability denied request"
      );
      await expect(
        applicationAction(fixture, {
          kind: "respond",
          identity: { ...fixture.identity, requestId: "denied-request" },
          outcome: { kind: "select", optionId: "allow" }
        })
      ).resolves.toMatchObject({ ok: false, code: "capability_denied" });

      owner.send({ kind: "capabilities", cancel: false });
      await owner.waitFor(
        (message) =>
          message.kind === "capabilities_set" &&
          (message.capabilities as { cancel?: unknown }).cancel === false,
        "cancel capability denial"
      );
      await expect(
        applicationAction(fixture, { kind: "cancel", identity: fixture.identity })
      ).resolves.toMatchObject({ ok: false, code: "capability_denied" });

      await owner.stop();
      owners.delete(owner);
      await expect(
        applicationAction(fixture, {
          kind: "cancel",
          identity: fixture.identity
        })
      ).resolves.toMatchObject({ ok: false, code: "not_active" });
    },
    testTimeoutMs
  );

  it(
    "handles real framing, disconnects, duplicate commands, and idempotent teardown",
    async () => {
      const fixture = await applicationFixture(`RUN-${"x".repeat(180)}`);
      const { owner, descriptor } = await startOwner(fixture);
      expect(descriptor.transport).toBe(process.platform === "win32" ? "named_pipe" : "unix");
      if (process.platform === "win32") {
        expect(descriptor.address).toMatch(/^\\\\\.\\pipe\\/u);
      } else {
        expect(Buffer.byteLength(descriptor.address, "utf8")).toBeLessThanOrEqual(100);
        expect(descriptor.address.startsWith(fixture.runDir)).toBe(false);
      }

      const idleSocket = createConnection(descriptor.address);
      await once(idleSocket, "connect");
      await Promise.race([
        once(idleSocket, "close"),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("Idle socket did not close in time.")),
            operationTimeoutMs
          )
        )
      ]);

      const partial = createConnection(descriptor.address);
      await once(partial, "connect");
      partial.write(frame({ protocol: "incomplete" }).subarray(0, 2));
      partial.destroy();

      owner.send({ kind: "add_request", requestKind: "permission", requestId: "split-request" });
      await owner.waitFor(
        (message) => message.kind === "request_ready" && message.requestId === "split-request",
        "split request readiness"
      );
      const splitCommand = command(fixture, descriptor, {
        kind: "respond",
        commandId: globalThis.crypto.randomUUID(),
        identity: { ...fixture.identity, requestId: "split-request" },
        outcome: { kind: "select", optionId: "allow" }
      });
      await expect(rawRequest(descriptor, splitCommand, 2)).resolves.toMatchObject({
        ok: true,
        result: { status: "delivered" }
      });

      owner.send({
        kind: "add_request",
        requestKind: "permission",
        requestId: "duplicate-request",
        delayMs: 75
      });
      await owner.waitFor(
        (message) => message.kind === "request_ready" && message.requestId === "duplicate-request",
        "duplicate request readiness"
      );
      const duplicateCommand = command(fixture, descriptor, {
        kind: "respond",
        commandId: globalThis.crypto.randomUUID(),
        identity: { ...fixture.identity, requestId: "duplicate-request" },
        outcome: { kind: "select", optionId: "deny" }
      });
      const [firstReceipt, secondReceipt] = await Promise.all([
        new AgentRunControlClient(descriptor, { timeoutMs: 1000 }).execute(duplicateCommand),
        new AgentRunControlClient(descriptor, { timeoutMs: 1000 }).execute(duplicateCommand)
      ]);
      expect(firstReceipt).toEqual(secondReceipt);
      expect(firstReceipt).toMatchObject({ ok: true, result: { status: "delivered" } });
      await owner.waitFor(deliveryFor("respond", "duplicate-request"), "duplicate delivery");
      expect(owner.matching(deliveryFor("respond", "duplicate-request"))).toHaveLength(1);

      owner.send({
        kind: "add_request",
        requestKind: "permission",
        requestId: "disconnect-request",
        delayMs: 75
      });
      await owner.waitFor(
        (message) => message.kind === "request_ready" && message.requestId === "disconnect-request",
        "disconnect request readiness"
      );
      const disconnectedCommand = command(fixture, descriptor, {
        kind: "respond",
        commandId: globalThis.crypto.randomUUID(),
        identity: { ...fixture.identity, requestId: "disconnect-request" },
        outcome: { kind: "select", optionId: "allow" }
      });
      const disconnected = createConnection(descriptor.address);
      await once(disconnected, "connect");
      disconnected.end(frame(disconnectedCommand));
      disconnected.destroy();
      await owner.waitFor(deliveryFor("respond", "disconnect-request"), "disconnected delivery");
      await expect(
        new AgentRunControlClient(descriptor, { timeoutMs: 1000 }).execute(disconnectedCommand)
      ).resolves.toMatchObject({ ok: true, result: { status: "delivered" } });
      expect(owner.matching(deliveryFor("respond", "disconnect-request"))).toHaveLength(1);

      await owner.stop();
      owners.delete(owner);
      await expect(readAgentRunControlDescriptor(fixture.runDir)).resolves.toBeNull();
      if (descriptor.transport === "unix") {
        await expect(lstat(descriptor.address)).rejects.toMatchObject({ code: "ENOENT" });
      }
    },
    testTimeoutMs
  );

  it(
    "fails boundedly through a stale descriptor after the owner process exits",
    async () => {
      const fixture = await applicationFixture();
      const { owner, descriptor } = await startOwner(fixture);
      await owner.terminate();
      owners.delete(owner);
      await expect(readAgentRunControlDescriptor(fixture.runDir)).resolves.toEqual(descriptor);

      const startedAt = Date.now();
      const response = await executeDesktopAgentRunControl(
        {
          ref: { projectRoot: fixture.root, canvasId: "default" },
          recordId: fixture.recordId,
          action: { kind: "cancel", identity: fixture.identity }
        },
        { locator: new AgentRunControlLocator({ clientOptions: { timeoutMs: 250 } }) }
      );
      expect(response).toMatchObject({ ok: false, code: "delivery_failed" });
      expect(Date.now() - startedAt).toBeLessThan(operationTimeoutMs);
    },
    testTimeoutMs
  );
});
