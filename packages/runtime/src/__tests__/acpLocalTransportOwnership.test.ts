import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createAcpConnection, type AcpConnection } from "../autoRun/acpConnection.js";
import type { AcpConnectionLease, AcpOwnedSession } from "../autoRun/acpConnectionProvider.js";
import { createAcpCleanupDeadline } from "../autoRun/acpExecutionCleanup.js";
import { executeLocalAcpAdapter } from "../autoRun/acpLocalExecutionAdapter.js";
import { createLocalAcpActiveRunHandle } from "../autoRun/acpLocalActiveRunHandle.js";
import { createSharedAcpConnectionProvider } from "../autoRun/acpSharedConnectionProvider.js";
import { ActiveAgentRunRegistry } from "../autoRun/activeAgentRunRegistry.js";
import { agentRunControlLeaseIdSchema } from "../autoRun/agentRunControlContract.js";
import {
  extractFinalArtifactEnvelope,
  finalArtifactPromptInstruction,
  materializeFinalArtifact
} from "../autoRun/finalArtifactContract.js";
import type { LivePendingOperationHandle } from "../autoRun/liveControl.js";
import { runnerSessionActionIdentitySchema } from "../autoRun/runnerContractSchemas.js";
import { ACP_MOCK_OPERATION_TIMEOUT_MS } from "./support/acpMockHarness.js";

const fixture = fileURLToPath(new URL("./support/acpMockAgent.mjs", import.meta.url));
const environment = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
);

function expectProcessExited(processId: number): void {
  try {
    process.kill(processId, 0);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
    throw error;
  }
  throw new Error(`Local ownership ACP process ${processId} is still alive.`);
}

describe("local ACP transport ownership", () => {
  it.each([
    "enumerated after handoff",
    "captured before handoff"
  ] as const)("preserves successful cleanup and a sibling session when operations are %s", async (timing) => {
    const directory = await mkdtemp(join(tmpdir(), "acp-local-ownership-"));
    await writeFile(join(directory, "pause"), "");
    await writeFile(join(directory, "pause-at"), "session/close");
    const registry = new ActiveAgentRunRegistry();
    const abortController = new AbortController();
    let connection: AcpConnection | undefined;
    let spawns = 0;
    const provider = createSharedAcpConnectionProvider({
      connect: (options) => {
        spawns += 1;
        connection = createAcpConnection(options);
        return connection;
      }
    });
    let siblingLease: AcpConnectionLease | undefined;
    let sibling: AcpOwnedSession | undefined;
    let handle: ReturnType<typeof createLocalAcpActiveRunHandle> | undefined;
    let captured: LivePendingOperationHandle | undefined;
    let removal: Promise<boolean> | undefined;
    let pauseReleased = false;
    let artifactValidated = false;
    let sawClosePending = false;
    const events: string[] = [];
    const waitForClose = async (): Promise<void> => {
      await vi.waitFor(
        async () => {
          expect(
            [...(connection?.pendingOperations.values() ?? [])].some(
              (operation) => operation.operation === "session/close"
            )
          ).toBe(true);
          expect(await readFile(join(directory, "lifecycle.log"), "utf8")).toContain(
            "paused session/close"
          );
        },
        { timeout: 700, interval: 5 }
      );
      sawClosePending = true;
    };
    const releasePause = async (): Promise<void> => {
      if (pauseReleased) return;
      pauseReleased = true;
      await unlink(join(directory, "pause"));
    };
    const expected = { kind: "implementation", ref: "T-001#B-001", taskId: "T-001" } as const;
    const execution = executeLocalAcpAdapter({
      launch: {
        command: process.execPath,
        args: [fixture, "load-capable-artifact", "--control-dir", directory]
      },
      cwd: directory,
      agentId: "local-ownership",
      env: environment,
      shutdown: { eofDrainMs: 1_000, terminateGraceMs: 50, cleanupDeadlineMs: 2_000 },
      capabilityPolicy: { required: [], optional: [] },
      prompt: `complete the implementation\n\n${finalArtifactPromptInstruction(expected)}`,
      sessionStart: { kind: "new" },
      signal: abortController.signal,
      timeoutMs: ACP_MOCK_OPERATION_TIMEOUT_MS,
      connectionMode: "shared-project",
      poolIdentity: {
        projectRoot: directory,
        profileFingerprint: "local-ownership",
        host: { kind: "native" }
      },
      provider: {
        async acquire(request) {
          const lease = await provider.acquire(request);
          siblingLease = await provider.acquire({ ...request, signal: undefined });
          await siblingLease.initialize();
          sibling = await siblingLease.openSession({ kind: "new" }, { ownerId: "sibling" });
          return lease;
        },
        shutdown: () => provider.shutdown()
      },
      onConnection: (owned) => {
        handle = createLocalAcpActiveRunHandle({
          identity: {
            scope: directory,
            executorRunId: "RUN-LOCAL",
            runSessionId: "SESSION-LOCAL",
            claimRef: expected.ref
          },
          connection: owned,
          abortController,
          eventSink: () => undefined,
          agentRunControlLeaseId: agentRunControlLeaseIdSchema.parse(randomUUID()),
          pendingRequests: new Map(),
          supportsSessionClose: () => true
        });
        handle.beforeRemove = async () => {
          await waitForClose();
          await captured?.reject("stale registry operation rejection");
        };
        registry.register(handle);
      },
      interactionBroker: {
        requestPermission: () => ({ kind: "cancel" }),
        requestElicitation: () => ({ action: "cancel" })
      },
      interactionDeadline: () => null,
      followUpPrompts: (async function* () {})(),
      eventSink: (event) => {
        if (event.kind === "terminal") events.push(event.terminal.state);
      },
      lifecycleObserver: async (event) => {
        if (!handle) throw new Error("Local ACP handle was not published.");
        if (event.kind === "session_ready") {
          registry.bindSession(handle, event.session.sessionId);
          registry.transition(handle, "ready");
          registry.transition(handle, "running");
        }
        if (event.kind === "prompts_completed") {
          await materializeFinalArtifact({
            envelope: extractFinalArtifactEnvelope(event.output, expected),
            expected,
            rootDir: directory,
            relativePath: "implementation.md"
          });
          artifactValidated = true;
        }
        if (event.kind === "cleanup_starting") {
          try {
            if (timing === "captured before handoff") {
              await waitForClose();
              captured = [...handle.control.pendingOperations.values()].find(
                (operation) => operation.operation === "session/close"
              );
              expect(captured).toBeDefined();
            }
            handle.releaseTransportControl();
            handle.releaseTransportControl();
            removal = registry.remove(handle, "engine cleanup", "succeeded", artifactValidated);
            await removal;
          } finally {
            await releasePause();
          }
        }
      }
    });
    const outcome = await execution.then(
      (result) => ({ result, error: undefined }),
      (error: unknown) => ({ result: undefined, error })
    );
    try {
      expect(sawClosePending).toBe(true);
      expect(artifactValidated).toBe(true);
      expect(await readFile(join(directory, "implementation.md"), "utf8")).toBe("implemented\n");
      expect(outcome.error).toBeUndefined();
      expect(outcome.result?.terminal).toMatchObject({ state: "succeeded" });
      expect(events).toEqual(["succeeded"]);
      expect(handle?.lifecycleState).toBe("succeeded");
      expect(registry.size).toBe(0);
      expect(handle).toBeDefined();
      if (!handle || !connection || !sibling || !siblingLease) throw new Error("Missing owner");
      expect(await registry.remove(handle, "repeat cleanup", "succeeded", true)).toBe(true);
      expect(await removal).toBe(true);
      await expect(
        sibling.prompt([
          {
            type: "text",
            text: `continue independently\n\n${finalArtifactPromptInstruction(expected)}`
          }
        ])
      ).resolves.toMatchObject({
        stopReason: "end_turn"
      });
      expect(connection.terminalFailure).toBeNull();
      expect(connection.pendingOperationCount).toBe(0);
      const log = await readFile(join(directory, "lifecycle.log"), "utf8");
      expect(spawns).toBe(1);
      expect(log.match(/^\d+ session\/new$/gm)).toHaveLength(2);
      expect(log.match(/^\d+ session\/prompt$/gm)).toHaveLength(2);
      expect(log.match(/^\d+ session\/close$/gm)).toHaveLength(1);
      const processId = connection.processId;
      expect(processId).not.toBeNull();
      await siblingLease.release({
        terminal: "succeeded",
        cleanupDeadline: createAcpCleanupDeadline(2_000)
      });
      await provider.shutdown();
      if (processId === null) throw new Error("Missing process id");
      expectProcessExited(processId);
    } finally {
      await releasePause();
      await provider.shutdown();
    }
  });

  it("honors real user cancellation before handoff while preserving the shared sibling", async () => {
    const directory = await mkdtemp(join(tmpdir(), "acp-local-cancel-"));
    await writeFile(join(directory, "pause"), "");
    await writeFile(join(directory, "pause-at"), "session/prompt");
    const registry = new ActiveAgentRunRegistry();
    const abortController = new AbortController();
    const provider = createSharedAcpConnectionProvider();
    let siblingLease: AcpConnectionLease | undefined;
    let sibling: AcpOwnedSession | undefined;
    let handle: ReturnType<typeof createLocalAcpActiveRunHandle> | undefined;
    const terminals: string[] = [];
    const execution = executeLocalAcpAdapter({
      launch: {
        command: process.execPath,
        args: [fixture, "close-capable", "--control-dir", directory]
      },
      cwd: directory,
      agentId: "local-cancellation",
      env: environment,
      shutdown: { eofDrainMs: 1_000, terminateGraceMs: 50, cleanupDeadlineMs: 2_000 },
      capabilityPolicy: { required: [], optional: [] },
      prompt: "wait for cancellation",
      sessionStart: { kind: "new" },
      signal: abortController.signal,
      timeoutMs: ACP_MOCK_OPERATION_TIMEOUT_MS,
      connectionMode: "shared-project",
      poolIdentity: {
        projectRoot: directory,
        profileFingerprint: "local-cancellation",
        host: { kind: "native" }
      },
      provider: {
        async acquire(request) {
          const lease = await provider.acquire(request);
          siblingLease = await provider.acquire({ ...request, signal: undefined });
          await siblingLease.initialize();
          sibling = await siblingLease.openSession({ kind: "new" }, { ownerId: "sibling" });
          return lease;
        },
        shutdown: () => provider.shutdown()
      },
      onConnection: (owned) => {
        handle = createLocalAcpActiveRunHandle({
          identity: {
            scope: directory,
            executorRunId: "RUN-CANCEL",
            runSessionId: "SESSION-CANCEL",
            claimRef: "T-001#B-001"
          },
          connection: owned,
          abortController,
          eventSink: () => undefined,
          agentRunControlLeaseId: agentRunControlLeaseIdSchema.parse(randomUUID()),
          pendingRequests: new Map(),
          supportsSessionClose: () => true
        });
        registry.register(handle);
      },
      interactionBroker: {
        requestPermission: () => ({ kind: "cancel" }),
        requestElicitation: () => ({ action: "cancel" })
      },
      interactionDeadline: () => null,
      followUpPrompts: (async function* () {})(),
      eventSink: (event) => {
        if (event.kind === "terminal") terminals.push(event.terminal.state);
      },
      lifecycleObserver: async (event) => {
        if (!handle) throw new Error("Missing cancellation owner");
        if (event.kind === "session_ready") {
          registry.bindSession(handle, event.session.sessionId);
          registry.transition(handle, "ready");
          registry.transition(handle, "running");
          handle.control.interventionCapabilities.cancel = true;
        }
        if (event.kind === "cleanup_starting") {
          handle.releaseTransportControl();
          await registry.remove(handle, "engine cancellation cleanup", "cancelled");
        }
      }
    });
    const outcome = execution.catch((error: unknown) => error);
    let pauseReleased = false;
    try {
      await vi.waitFor(async () => {
        expect(await readFile(join(directory, "lifecycle.log"), "utf8")).toContain(
          "paused session/prompt"
        );
      });
      if (!handle || !sibling || !siblingLease) throw new Error("Missing shared sessions");
      expect(
        [...handle.control.pendingOperations.values()].map((operation) => operation.operation)
      ).toContain("session/prompt");
      if (!handle.identity.sessionId) throw new Error("Missing cancellation session id");
      await registry.cancel(runnerSessionActionIdentitySchema.parse(handle.identity));
      await unlink(join(directory, "pause"));
      pauseReleased = true;
      await outcome;
      expect(abortController.signal.aborted).toBe(true);
      expect(abortController.signal.reason.message).toBe("ACP session cancellation was requested.");
      expect(terminals).toEqual(["cancelled"]);
      expect(handle.lifecycleState).toBe("cancelled");
      expect(registry.size).toBe(0);
      await expect(
        sibling.prompt([{ type: "text", text: "continue after cancellation" }])
      ).resolves.toMatchObject({
        stopReason: "end_turn"
      });
      const processId = siblingLease.processId;
      await siblingLease.release({
        terminal: "succeeded",
        cleanupDeadline: createAcpCleanupDeadline(2_000)
      });
      await provider.shutdown();
      if (processId === null) throw new Error("Missing process id");
      expectProcessExited(processId);
    } finally {
      if (!pauseReleased) await unlink(join(directory, "pause"));
      await provider.shutdown();
      await outcome;
    }
  });
});
