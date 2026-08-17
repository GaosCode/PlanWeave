import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createAcpConnection } from "../autoRun/acpConnection.js";
import { createAcpCleanupDeadline } from "../autoRun/acpExecutionCleanup.js";
import { executeAcp } from "../autoRun/acpExecutionEngine.js";
import {
  AcpSharedConnectionAuthRequiredError,
  AcpSharedConnectionLostError
} from "../autoRun/acpSharedConnectionErrors.js";
import { acpSharedConnectionKey } from "../autoRun/acpSharedConnectionKey.js";
import { createSharedAcpConnectionProvider } from "../autoRun/acpSharedConnectionProvider.js";
import type {
  AcpConnectionLease,
  AcpConnectionProvider
} from "../autoRun/acpConnectionProvider.js";
import { ACP_MOCK_OPERATION_TIMEOUT_MS } from "./support/acpMockHarness.js";
import { defineAcpConnectionProviderContract } from "./acpDedicatedConnectionProvider.test.js";

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
  throw new Error(`ACP shared provider process ${processId} is still alive.`);
}

function acquireRequest(scenario: string, identity?: { fingerprint?: string; cwd?: string }) {
  return {
    launch: { trusted: true as const, command: process.execPath, args: [fixture, scenario] },
    cwd: identity?.cwd ?? process.cwd(),
    env: environment,
    clientInfo: { name: "planweave-shared-provider-contract", version: "1.0.0" },
    shutdown: { eofDrainMs: 25, terminateGraceMs: 25, cleanupDeadlineMs: 300 },
    defaultTimeoutMs: ACP_MOCK_OPERATION_TIMEOUT_MS,
    poolIdentity: {
      projectRoot: identity?.cwd ?? process.cwd(),
      profileFingerprint: identity?.fingerprint ?? "shared-fingerprint",
      host: { kind: "native" as const }
    }
  };
}

function countingConnect() {
  let initializes = 0;
  let processes = 0;
  return {
    stats: () => ({ initializes, processes }),
    connect: (options: Parameters<typeof createAcpConnection>[0]) => {
      processes += 1;
      const connection = createAcpConnection(options);
      const initialize = connection.initialize.bind(connection);
      connection.initialize = async (operationOptions) => {
        initializes += 1;
        return initialize(operationOptions);
      };
      return connection;
    }
  };
}

defineAcpConnectionProviderContract("shared-project", () =>
  createSharedAcpConnectionProvider({ idleMs: 20 })
);

describe("shared ACP connection provider", () => {
  const providers: AcpConnectionProvider[] = [];
  const leases: AcpConnectionLease[] = [];

  afterEach(async () => {
    await Promise.all(
      leases.splice(0).map((lease) =>
        lease.release({
          terminal: "failed",
          cleanupDeadline: createAcpCleanupDeadline(300)
        })
      )
    );
    await Promise.all(providers.splice(0).map((provider) => provider.shutdown()));
  });

  function track(provider: AcpConnectionProvider): AcpConnectionProvider {
    providers.push(provider);
    return provider;
  }

  async function acquire(
    provider: AcpConnectionProvider,
    scenario: string,
    identity?: { fingerprint?: string; cwd?: string }
  ): Promise<AcpConnectionLease> {
    const lease = await provider.acquire(acquireRequest(scenario, identity));
    leases.push(lease);
    return lease;
  }

  it("uses one process and one initialize for the same pool key", async () => {
    const counted = countingConnect();
    const provider = track(
      createSharedAcpConnectionProvider({ connect: counted.connect, idleMs: 20 })
    );
    const first = await acquire(provider, "success");
    const second = await acquire(provider, "success");
    await first.initialize();
    await second.initialize();
    expect(first.processId).toBe(second.processId);
    expect(counted.stats()).toEqual({ processes: 1, initializes: 1 });
  });

  it("starts two processes when the pool key differs", async () => {
    const counted = countingConnect();
    const provider = track(
      createSharedAcpConnectionProvider({ connect: counted.connect, idleMs: 20 })
    );
    const first = await acquire(provider, "success", { fingerprint: "alpha" });
    const second = await acquire(provider, "success", { fingerprint: "beta" });
    await first.initialize();
    await second.initialize();
    expect(first.processId).not.toBe(second.processId);
    expect(counted.stats().processes).toBe(2);
  });

  it("runs two sessions concurrently without crosstalk", async () => {
    const provider = track(createSharedAcpConnectionProvider({ idleMs: 20 }));
    const first = await acquire(provider, "success");
    const second = await acquire(provider, "success");
    await first.initialize();
    await second.initialize();
    const firstUpdates: string[] = [];
    const secondUpdates: string[] = [];
    const sessionA = await first.openSession(
      { kind: "new" },
      {
        ownerId: "owner-a",
        handlers: {
          onSessionUpdate: (notification) => {
            firstUpdates.push(notification.sessionId);
          }
        }
      }
    );
    const sessionB = await second.openSession(
      { kind: "new" },
      {
        ownerId: "owner-b",
        handlers: {
          onSessionUpdate: (notification) => {
            secondUpdates.push(notification.sessionId);
          }
        }
      }
    );
    expect(sessionA.sessionId).not.toBe(sessionB.sessionId);
    const [responseA, responseB] = await Promise.all([
      sessionA.prompt([{ type: "text", text: "alpha" }]),
      sessionB.prompt([{ type: "text", text: "beta" }])
    ]);
    expect(responseA.stopReason).toBe("end_turn");
    expect(responseB.stopReason).toBe("end_turn");
    expect(firstUpdates.every((sessionId) => sessionId === sessionA.sessionId)).toBe(true);
    expect(secondUpdates.every((sessionId) => sessionId === sessionB.sessionId)).toBe(true);
    expect(firstUpdates).not.toEqual([]);
    expect(secondUpdates).not.toEqual([]);
  });

  it("cancels one session while the other continues", async () => {
    const provider = track(createSharedAcpConnectionProvider({ idleMs: 20 }));
    const first = await acquire(provider, "slow-prompt");
    const second = await acquire(provider, "slow-prompt");
    await first.initialize();
    await second.initialize();
    const sessionA = await first.openSession({ kind: "new" }, { ownerId: "cancel-a" });
    const sessionB = await second.openSession({ kind: "new" }, { ownerId: "cancel-b" });
    const promptedA = sessionA.prompt([{ type: "text", text: "slow-a" }]);
    const promptedB = sessionB.prompt([{ type: "text", text: "slow-b" }]);
    await sessionA.cancel();
    await expect(promptedA).resolves.toMatchObject({ stopReason: "cancelled" });
    await expect(promptedB).resolves.toMatchObject({ stopReason: "end_turn" });
  });

  it("closes one advertised session and keeps the other promptable", async () => {
    const provider = track(createSharedAcpConnectionProvider({ idleMs: 40 }));
    const first = await acquire(provider, "close-capable");
    const second = await acquire(provider, "close-capable");
    await first.initialize();
    await second.initialize();
    expect(first.advertised.closeSession).toBe(true);
    await first.openSession({ kind: "new" }, { ownerId: "close-a" });
    const sessionB = await second.openSession({ kind: "new" }, { ownerId: "close-b" });
    const released = await first.release({
      terminal: "succeeded",
      cleanupDeadline: createAcpCleanupDeadline(300)
    });
    expect(released).toMatchObject({ closedSession: true, disposed: false, failures: [] });
    await expect(sessionB.prompt([{ type: "text", text: "still-open" }])).resolves.toMatchObject({
      stopReason: "end_turn"
    });
    const processId = second.processId;
    const last = second.release({
      terminal: "succeeded",
      cleanupDeadline: createAcpCleanupDeadline(300)
    });
    if (processId === null) throw new Error("shared close-capable process id is missing");
    process.kill(processId, 0);
    const lastReleased = await last;
    expect(lastReleased).toMatchObject({ closedSession: true, disposed: true, failures: [] });
    expectProcessExited(processId);
  });

  it("disposes immediately on last release when session-close is not advertised", async () => {
    const provider = track(createSharedAcpConnectionProvider({ idleMs: 2_000 }));
    const first = await acquire(provider, "success");
    const second = await acquire(provider, "success");
    await first.initialize();
    await second.initialize();
    expect(first.advertised.closeSession).toBe(false);
    await first.openSession({ kind: "new" }, { ownerId: "noclose-a" });
    await second.openSession({ kind: "new" }, { ownerId: "noclose-b" });
    await first.release({
      terminal: "succeeded",
      cleanupDeadline: createAcpCleanupDeadline(300)
    });
    const processId = second.processId;
    const started = Date.now();
    const released = await second.release({
      terminal: "succeeded",
      cleanupDeadline: createAcpCleanupDeadline(300)
    });
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(released).toMatchObject({ closedSession: false, disposed: true, failures: [] });
    if (processId === null) throw new Error("shared no-close process id is missing");
    expectProcessExited(processId);
  });

  it("fans out connection death once per owner without replaying prompts", async () => {
    const provider = track(createSharedAcpConnectionProvider({ idleMs: 20 }));
    const first = await acquire(provider, "success");
    const second = await acquire(provider, "success");
    await first.initialize();
    await second.initialize();
    const sessionA = await first.openSession({ kind: "new" }, { ownerId: "lost-a" });
    const sessionB = await second.openSession({ kind: "new" }, { ownerId: "lost-b" });
    const processId = first.processId;
    if (processId === null) throw new Error("shared death process id is missing");
    process.kill(processId, "SIGKILL");
    await first.closed;
    await second.closed;
    expect(first.terminalFailure).toBeInstanceOf(AcpSharedConnectionLostError);
    expect(second.terminalFailure).toBeInstanceOf(AcpSharedConnectionLostError);
    await expect(sessionA.prompt([{ type: "text", text: "replay-a" }])).rejects.toBeInstanceOf(
      AcpSharedConnectionLostError
    );
    await expect(sessionB.prompt([{ type: "text", text: "replay-b" }])).rejects.toBeInstanceOf(
      AcpSharedConnectionLostError
    );
  });

  it("fails the second open when the agent cannot create another session", async () => {
    const provider = track(createSharedAcpConnectionProvider({ idleMs: 20 }));
    const first = await acquire(provider, "single-session");
    const second = await acquire(provider, "single-session");
    await first.initialize();
    await second.initialize();
    await first.openSession({ kind: "new" }, { ownerId: "single-a" });
    await expect(second.openSession({ kind: "new" }, { ownerId: "single-b" })).rejects.toThrow(
      /Invalid params|one session/
    );
  });

  it("disposes the spawned process when start fails after initialize", async () => {
    let processId: number | null = null;
    const provider = track(
      createSharedAcpConnectionProvider({
        idleMs: 20,
        connect: (options) => {
          const connection = createAcpConnection(options);
          processId = connection.processId;
          const initialize = connection.initialize.bind(connection);
          connection.initialize = async (operationOptions) => {
            await initialize(operationOptions);
            throw new Error("scripted initialize failure");
          };
          return connection;
        }
      })
    );
    await expect(acquire(provider, "success")).rejects.toThrow("scripted initialize failure");
    if (processId === null) throw new Error("shared start-failure process id is missing");
    expectProcessExited(processId);
  });

  it("disposes the spawned process when authenticate fails after spawn", async () => {
    let processId: number | null = null;
    const provider = track(
      createSharedAcpConnectionProvider({
        idleMs: 20,
        connect: (options) => {
          const connection = createAcpConnection(options);
          processId = connection.processId;
          connection.authenticate = async () => {
            throw new Error("scripted authenticate failure");
          };
          return connection;
        }
      })
    );
    await expect(
      provider.acquire({
        ...acquireRequest("env-auth"),
        env: { ...environment, PLANWEAVE_T002_TEST_API_KEY: "present" }
      })
    ).rejects.toThrow("scripted authenticate failure");
    if (processId === null) throw new Error("shared authenticate-failure process id is missing");
    expectProcessExited(processId);
  });

  it("completes a close-capable last release when a new acquire reuses the idle connection", async () => {
    const provider = track(createSharedAcpConnectionProvider({ idleMs: 80 }));
    const first = await acquire(provider, "close-capable");
    await first.initialize();
    await first.openSession({ kind: "new" }, { ownerId: "idle-a" });
    const releasing = first.release({
      terminal: "succeeded",
      cleanupDeadline: createAcpCleanupDeadline(300)
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const second = await acquire(provider, "close-capable");
    const firstReleased = await releasing;
    expect(firstReleased).toMatchObject({ closedSession: true, disposed: false, failures: [] });
    expect(second.processId).toBe(first.processId);
    await second.initialize();
    const session = await second.openSession({ kind: "new" }, { ownerId: "idle-b" });
    await expect(session.prompt([{ type: "text", text: "reused" }])).resolves.toMatchObject({
      stopReason: "end_turn"
    });
  });

  it("poisons remaining owners once when session close fails", async () => {
    const provider = track(createSharedAcpConnectionProvider({ idleMs: 20 }));
    const first = await acquire(provider, "close-capable-error");
    const second = await acquire(provider, "close-capable-error");
    await first.initialize();
    await second.initialize();
    await first.openSession({ kind: "new" }, { ownerId: "poison-a" });
    const sessionB = await second.openSession({ kind: "new" }, { ownerId: "poison-b" });
    const processId = first.processId;
    const released = await first.release({
      terminal: "succeeded",
      cleanupDeadline: createAcpCleanupDeadline(300)
    });
    expect(released.closedSession).toBe(false);
    expect(released.disposed).toBe(true);
    expect(released.failures.length).toBeGreaterThan(0);
    expect(second.terminalFailure).toBeInstanceOf(AcpSharedConnectionLostError);
    expect(first.terminalFailure).not.toBeInstanceOf(AcpSharedConnectionLostError);
    await expect(sessionB.prompt([{ type: "text", text: "after-poison" }])).rejects.toBeInstanceOf(
      AcpSharedConnectionLostError
    );
    if (processId === null) throw new Error("shared close-failure process id is missing");
    expectProcessExited(processId);
  });

  it("fails acquire with a typed error when only interactive auth is advertised", async () => {
    const provider = track(createSharedAcpConnectionProvider({ idleMs: 20 }));
    await expect(acquire(provider, "action-required")).rejects.toBeInstanceOf(
      AcpSharedConnectionAuthRequiredError
    );
  });

  it("does not treat a key digest as logged environment values", () => {
    const secret = "raw-shared-env-secret";
    const key = acpSharedConnectionKey({
      cwd: process.cwd(),
      launch: { trusted: true, command: "/bin/agent", args: [] },
      env: { CUSTOM_SECRET: secret },
      poolIdentity: {
        projectRoot: process.cwd(),
        profileFingerprint: "fp",
        host: { kind: "native" }
      }
    });
    expect(key).not.toContain(secret);
    expect(key).not.toContain("CUSTOM_SECRET=");
  });
});

describe("ACP engine shared-project gate", () => {
  it("does not fail shared-project when session-close is absent", async () => {
    const result = await executeAcp({
      launch: { trusted: true, command: process.execPath, args: [fixture, "success"] },
      workspace: { cwd: process.cwd() },
      env: environment,
      clientInfo: { name: "planweave-shared-engine", version: "1.0.0" },
      shutdown: { eofDrainMs: 25, terminateGraceMs: 25, cleanupDeadlineMs: 300 },
      capabilityPolicy: { required: [], optional: [] },
      prompt: "shared gate",
      sessionStart: { kind: "new" },
      connectionMode: "shared-project",
      limits: {
        operationTimeoutMs: ACP_MOCK_OPERATION_TIMEOUT_MS,
        interactionTimeoutMs: ACP_MOCK_OPERATION_TIMEOUT_MS
      },
      connect: (options) => createAcpConnection(options)
    });
    expect(result.capabilitySnapshot?.required).not.toContain("session-close");
    expect(result.capabilitySnapshot?.missing).toEqual([]);
    expect(result.terminal.state).toBe("succeeded");
  });
});
