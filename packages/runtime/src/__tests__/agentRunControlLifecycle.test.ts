import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { ActiveAgentRunRegistry } from "../autoRun/activeAgentRunRegistry.js";
import {
  agentRunControlCancelCommandSchema,
  agentRunControlFollowUpCommandSchema,
  agentRunControlResponseSchema,
  type AgentRunControlCommand,
  type AgentRunControlEndpointDescriptor,
  type AgentRunControlResponse
} from "../autoRun/agentRunControlContract.js";
import {
  agentRunControlDescriptorPath,
  readAgentRunControlDescriptor
} from "../autoRun/agentRunControlEndpoint.js";
import { AcpOwnerStateWriter } from "../autoRun/acpOwnerState.js";
import { AgentRunControlServer } from "../autoRun/agentRunControlServer.js";
import { AcpSessionController, type AcpSessionRun } from "../autoRun/acpSessionController.js";

const fixture = fileURLToPath(new URL("./support/acpMockAgent.mjs", import.meta.url));
const frameHeaderBytes = 4;

function controllerRun(root: string, scenario: string): AcpSessionRun {
  return {
    kind: "implementation",
    identity: {
      scope: root,
      desktopRunId: "AUTO-RUN-001",
      runSessionId: "SESSION-001",
      executorRunId: "RUN-001",
      claimRef: "T-001#B-001"
    },
    runDir: root,
    metadataPath: join(root, "metadata.json"),
    prompt: "implement",
    cwd: root,
    launch: { command: process.execPath, args: [fixture, scenario] },
    executorName: "mock-acp",
    agentId: "codex",
    taskId: "T-001",
    metadataIdentity: { blockId: "B-001" },
    projectId: "project-1",
    canvasId: "default"
  };
}

async function executeWithPublishedControl(
  root: string,
  scenario: string,
  registry: ActiveAgentRunRegistry,
  options: { signal?: AbortSignal; timeoutMs: number },
  holdAfterAvailability = false
) {
  const originalStart = AgentRunControlServer.prototype.start;
  let publishDescriptor!: (descriptor: AgentRunControlEndpointDescriptor) => void;
  let releaseStartup = () => undefined;
  const descriptorPublished = new Promise<AgentRunControlEndpointDescriptor>((resolve) => {
    publishDescriptor = resolve;
  });
  let availabilityPublished = Promise.resolve();
  let availability: ReturnType<typeof vi.spyOn> | undefined;
  const start = vi
    .spyOn(AgentRunControlServer.prototype, "start")
    .mockImplementation(async function () {
      const descriptor = await originalStart.call(this);
      publishDescriptor(descriptor);
      return descriptor;
    });
  if (holdAfterAvailability) {
    const originalSetControlAvailability = AcpOwnerStateWriter.prototype.setControlAvailability;
    let publishAvailability!: () => void;
    availabilityPublished = new Promise<void>((resolve) => {
      publishAvailability = resolve;
    });
    const startupReleased = new Promise<void>((resolve) => {
      releaseStartup = resolve;
    });
    availability = vi
      .spyOn(AcpOwnerStateWriter.prototype, "setControlAvailability")
      .mockImplementation(async function (summary) {
        await originalSetControlAvailability.call(this, summary);
        if (summary.controlAvailable) {
          publishAvailability();
          await startupReleased;
        }
      });
  }
  const execution = new AcpSessionController(registry).execute(
    controllerRun(root, scenario),
    options
  );
  void execution.catch(() => undefined);
  try {
    const [descriptor] = await Promise.all([descriptorPublished, availabilityPublished]);
    return { descriptor, execution, releaseStartup };
  } finally {
    availability?.mockRestore();
    start.mockRestore();
  }
}

async function liveControlMetadata(root: string): Promise<Record<string, unknown>> {
  let metadata: Record<string, unknown> = {};
  await vi.waitFor(async () => {
    metadata = JSON.parse(await readFile(join(root, "metadata.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(metadata.controlAvailable).toBe(true);
  });
  return metadata;
}

function commandFrame(command: AgentRunControlCommand): Buffer {
  const payload = Buffer.from(JSON.stringify(command), "utf8");
  const result = Buffer.alloc(frameHeaderBytes + payload.byteLength);
  result.writeUInt32BE(payload.byteLength, 0);
  payload.copy(result, frameHeaderBytes);
  return result;
}

function sendCommand(address: string, command: AgentRunControlCommand) {
  return new Promise<AgentRunControlResponse>((resolve, reject) => {
    const socket = connect(address);
    let buffered = Buffer.alloc(0);
    socket.once("error", reject);
    socket.once("connect", () => socket.write(commandFrame(command)));
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.byteLength < frameHeaderBytes) return;
      const length = buffered.readUInt32BE(0);
      if (buffered.byteLength < frameHeaderBytes + length) return;
      try {
        resolve(
          agentRunControlResponseSchema.parse(
            JSON.parse(
              buffered.subarray(frameHeaderBytes, frameHeaderBytes + length).toString("utf8")
            ) as unknown
          )
        );
      } catch (error) {
        reject(error);
      } finally {
        socket.destroy();
      }
    });
  });
}

async function expectEndpointClosed(root: string, address: string): Promise<void> {
  await expect(readAgentRunControlDescriptor(root)).resolves.toBeNull();
  await expect(
    new Promise<void>((resolve, reject) => {
      const socket = connect(address);
      socket.once("connect", () => {
        socket.destroy();
        reject(new Error("Control endpoint remained connectable after teardown."));
      });
      socket.once("error", () => resolve());
    })
  ).resolves.toBeUndefined();
}

function nestedErrorMessages(error: unknown): string[] {
  if (error instanceof AggregateError) {
    return [error.message, ...error.errors.flatMap(nestedErrorMessages)];
  }
  return error instanceof Error ? [error.message] : [String(error)];
}

function findAggregateError(error: unknown, message: string): AggregateError | null {
  if (!(error instanceof AggregateError)) return null;
  if (error.message === message) return error;
  for (const nested of error.errors) {
    const match = findAggregateError(nested, message);
    if (match) return match;
  }
  return null;
}

describe("agent run control controller lifecycle", () => {
  it("publishes only while live and tears down on completed and fatal runs", async () => {
    for (const [scenario, succeeds] of [
      ["delayed-artifact-implementation", true],
      ["delayed", false]
    ] as const) {
      const root = await mkdtemp(join(tmpdir(), `planweave-control-${scenario}-`));
      const { descriptor, execution, releaseStartup } = await executeWithPublishedControl(
        root,
        scenario,
        new ActiveAgentRunRegistry(),
        { timeoutMs: 2_000 },
        true
      );
      const liveMetadata = await liveControlMetadata(root);
      expect(liveMetadata).toMatchObject({
        controlAvailable: true,
        controlOwnerPid: process.pid,
        controlUnavailableReason: null
      });
      expect(JSON.stringify(liveMetadata)).not.toContain(descriptor.address);
      releaseStartup();
      if (succeeds) await expect(execution).resolves.toMatchObject({ exitCode: 0 });
      else await expect(execution).rejects.toThrow("Final artifact marker was not found");
      await expectEndpointClosed(root, descriptor.address);
      await expect(readFile(join(root, "metadata.json"), "utf8")).resolves.toContain(
        '"controlUnavailableReason": "owner_terminal"'
      );
    }
  });

  it("returns a typed cancel receipt before closing the endpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-control-cancel-"));
    const registry = new ActiveAgentRunRegistry();
    const { descriptor, execution, releaseStartup } = await executeWithPublishedControl(
      root,
      "long-prompt",
      registry,
      { timeoutMs: 2_000 }
    );
    releaseStartup();
    const response = await sendCommand(
      descriptor.address,
      agentRunControlCancelCommandSchema.parse({
        version: "planweave.agent-run-control/v1",
        commandId: "22222222-2222-4222-8222-222222222222",
        leaseId: descriptor.leaseId,
        kind: "cancel",
        identity: {
          scope: root,
          desktopRunId: "AUTO-RUN-001",
          runSessionId: "SESSION-001",
          executorRunId: "RUN-001",
          claimRef: "T-001#B-001",
          sessionId: "mock-session-1"
        }
      })
    );
    expect(response).toMatchObject({ ok: true, result: { status: "delivered" } });
    await expect(execution).rejects.toMatchObject({ name: "AbortError" });
    await expectEndpointClosed(root, descriptor.address);
    await expect(registry.shutdown()).resolves.toBeUndefined();
    await expect(registry.shutdown()).resolves.toBeUndefined();
  });

  it("rejects a queued follow-up before awaiting fatal endpoint teardown", async () => {
    const root = await mkdtemp(join(tmpdir(), "planweave-control-fatal-queue-"));
    const registry = new ActiveAgentRunRegistry();
    const shutdown = new AbortController();
    const { descriptor, execution, releaseStartup } = await executeWithPublishedControl(
      root,
      "long-prompt",
      registry,
      { signal: shutdown.signal, timeoutMs: 2_000 }
    );
    releaseStartup();
    const followUp = sendCommand(
      descriptor.address,
      agentRunControlFollowUpCommandSchema.parse({
        version: "planweave.agent-run-control/v1",
        commandId: "33333333-3333-4333-8333-333333333333",
        leaseId: descriptor.leaseId,
        kind: "follow_up",
        identity: {
          scope: root,
          desktopRunId: "AUTO-RUN-001",
          runSessionId: "SESSION-001",
          executorRunId: "RUN-001",
          claimRef: "T-001#B-001",
          sessionId: "mock-session-1"
        },
        prompt: "queued while the initial turn is still running"
      })
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    shutdown.abort(new Error("fatal owner shutdown"));

    await expect(followUp).resolves.toMatchObject({ ok: false, code: "delivery_failed" });
    await expect(execution).rejects.toThrow();
    await expectEndpointClosed(root, descriptor.address);
    await expect(registry.shutdown()).resolves.toBeUndefined();
    await expect(registry.shutdown()).resolves.toBeUndefined();
  });

  it("still removes the live owner and endpoint when terminal availability persistence fails", async () => {
    const originalSetControlAvailability = AcpOwnerStateWriter.prototype.setControlAvailability;
    let terminalWriteAttempts = 0;
    const preparationFailure = new Error("owner-state prepare failed");
    const stopFailure = new Error("owner-state stop failed");
    const retryFailure = new Error("owner-state retry failed");
    const persistence = vi
      .spyOn(AcpOwnerStateWriter.prototype, "setControlAvailability")
      .mockImplementation(async function (summary) {
        if (summary.controlUnavailableReason === "owner_terminal") {
          terminalWriteAttempts += 1;
          if (terminalWriteAttempts === 1) {
            throw preparationFailure;
          }
          if (terminalWriteAttempts === 2) throw stopFailure;
          throw retryFailure;
        }
        return originalSetControlAvailability.call(this, summary);
      });
    const root = await mkdtemp(join(tmpdir(), "planweave-control-owner-state-failure-"));
    const registry = new ActiveAgentRunRegistry();
    try {
      const { descriptor, execution, releaseStartup } = await executeWithPublishedControl(
        root,
        "delayed-artifact-implementation",
        registry,
        { timeoutMs: 2_000 }
      );
      releaseStartup();

      const failure = await execution.catch((error: unknown) => error);
      const messages = nestedErrorMessages(failure);
      expect(failure).toBeInstanceOf(AggregateError);
      expect(messages).toContain("owner-state prepare failed");
      expect(messages).toContain("owner-state stop failed");
      expect(messages).toContain("owner-state retry failed");
      expect(
        findAggregateError(failure, "Runner terminal cleanup did not complete cleanly.")?.errors
      ).toEqual([preparationFailure, stopFailure]);
      expect(terminalWriteAttempts).toBe(3);
      await expectEndpointClosed(root, descriptor.address);
      expect(registry.size).toBe(0);
      await expect(registry.shutdown()).resolves.toBeUndefined();
      await expect(readFile(join(root, "metadata.json"), "utf8")).resolves.toContain(
        "owner-state retry failed"
      );
      expect(persistence).toHaveBeenCalledWith(
        expect.objectContaining({ controlUnavailableReason: "owner_terminal" })
      );
    } finally {
      persistence.mockRestore();
    }
  });

  it.each([
    ["prepare", 1],
    ["stop", 2]
  ] as const)("rethrows a single owner-state %s failure by identity", async (phase, failingAttempt) => {
    const originalSetControlAvailability = AcpOwnerStateWriter.prototype.setControlAvailability;
    const ownerStateFailure = new Error(`owner-state ${phase} failed`);
    let terminalWriteAttempts = 0;
    const persistence = vi
      .spyOn(AcpOwnerStateWriter.prototype, "setControlAvailability")
      .mockImplementation(async function (summary) {
        if (summary.controlUnavailableReason === "owner_terminal") {
          terminalWriteAttempts += 1;
          if (terminalWriteAttempts === failingAttempt) {
            throw ownerStateFailure;
          }
        }
        return originalSetControlAvailability.call(this, summary);
      });
    const root = await mkdtemp(join(tmpdir(), `planweave-control-owner-${phase}-failure-`));
    const registry = new ActiveAgentRunRegistry();
    try {
      const { descriptor, execution, releaseStartup } = await executeWithPublishedControl(
        root,
        "delayed-artifact-implementation",
        registry,
        { timeoutMs: 2_000 }
      );
      releaseStartup();

      await expect(execution).rejects.toBe(ownerStateFailure);
      expect(terminalWriteAttempts).toBe(failingAttempt === 2 ? 3 : 2);
      await expectEndpointClosed(root, descriptor.address);
      expect(registry.size).toBe(0);
    } finally {
      persistence.mockRestore();
    }
  });

  it("retains cleanup ownership when availability persistence and initial teardown both fail", async () => {
    const originalSetControlAvailability = AcpOwnerStateWriter.prototype.setControlAvailability;
    const originalStart = AgentRunControlServer.prototype.start;
    const originalStop = AgentRunControlServer.prototype.stop;
    const availabilityFailure = new Error("control availability persistence failed");
    const teardownFailure = new Error("initial endpoint teardown failed");
    let capturedServer: AgentRunControlServer | null = null;
    let stopAttempts = 0;
    let publishDescriptor!: (descriptor: AgentRunControlEndpointDescriptor) => void;
    const descriptorPublished = new Promise<AgentRunControlEndpointDescriptor>((resolve) => {
      publishDescriptor = resolve;
    });
    const persistence = vi
      .spyOn(AcpOwnerStateWriter.prototype, "setControlAvailability")
      .mockImplementation(async function (summary) {
        if (summary.controlAvailable) throw availabilityFailure;
        return originalSetControlAvailability.call(this, summary);
      });
    const start = vi
      .spyOn(AgentRunControlServer.prototype, "start")
      .mockImplementation(async function () {
        const descriptor = await originalStart.call(this);
        publishDescriptor(descriptor);
        return descriptor;
      });
    const stop = vi.spyOn(AgentRunControlServer.prototype, "stop").mockImplementation(function () {
      capturedServer = this;
      stopAttempts += 1;
      if (stopAttempts === 1) return Promise.reject(teardownFailure);
      return originalStop.call(this);
    });
    const root = await mkdtemp(join(tmpdir(), "planweave-control-start-cleanup-failure-"));
    const registry = new ActiveAgentRunRegistry();
    try {
      const execution = new AcpSessionController(registry).execute(
        controllerRun(root, "delayed-artifact-implementation"),
        { timeoutMs: 2_000 }
      );
      const failurePromise = execution.catch((error: unknown) => error);
      const descriptor = await descriptorPublished;

      const failure = await failurePromise;
      expect(failure).toBeInstanceOf(AggregateError);
      expect(nestedErrorMessages(failure)).toEqual(
        expect.arrayContaining([
          "control availability persistence failed",
          "initial endpoint teardown failed"
        ])
      );
      expect(stopAttempts).toBeGreaterThanOrEqual(2);
      await expectEndpointClosed(root, descriptor.address);
      expect(registry.size).toBe(0);
    } finally {
      persistence.mockRestore();
      start.mockRestore();
      stop.mockRestore();
      if (capturedServer) await originalStop.call(capturedServer).catch(() => undefined);
    }
  });

  it.runIf(process.platform !== "win32")(
    "keeps in-process execution available when endpoint publication fails",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "planweave-control-start-failure-"));
      await mkdir(join(root, "control"), { mode: 0o755 });
      const execution = new AcpSessionController(new ActiveAgentRunRegistry()).execute(
        controllerRun(root, "delayed-artifact-implementation"),
        { timeoutMs: 2_000 }
      );
      await vi.waitFor(async () => {
        const metadata = JSON.parse(await readFile(join(root, "metadata.json"), "utf8")) as Record<
          string,
          unknown
        >;
        expect(metadata).toMatchObject({
          controlAvailable: false,
          controlUnavailableReason: "endpoint_start_failed"
        });
      });
      await expect(execution).resolves.toMatchObject({ exitCode: 0 });
      await expect(readFile(agentRunControlDescriptorPath(root), "utf8")).rejects.toMatchObject({
        code: "ENOENT"
      });
    }
  );
});
