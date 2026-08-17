import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { createDedicatedAcpConnectionProvider } from "../autoRun/acpDedicatedConnectionProvider.js";
import { AcpLeaseReleasedError } from "../autoRun/acpConnectionProvider.js";
import type { AcpConnectionProvider } from "../autoRun/acpConnectionProvider.js";
import { createAcpCleanupDeadline } from "../autoRun/acpExecutionCleanup.js";
import { ACP_MOCK_OPERATION_TIMEOUT_MS } from "./support/acpMockHarness.js";

const fixture = fileURLToPath(new URL("./support/acpMockAgent.mjs", import.meta.url));
const environment = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
);

function expectProcessExited(processId: number): void {
  try {
    process.kill(processId, 0);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return;
    }
    throw error;
  }
  throw new Error(`ACP provider contract process ${processId} is still alive.`);
}

function acquireRequest(scenario: string) {
  return {
    launch: { trusted: true as const, command: process.execPath, args: [fixture, scenario] },
    cwd: process.cwd(),
    env: environment,
    clientInfo: { name: "planweave-provider-contract", version: "1.0.0" },
    shutdown: { eofDrainMs: 25, terminateGraceMs: 25, cleanupDeadlineMs: 300 },
    defaultTimeoutMs: ACP_MOCK_OPERATION_TIMEOUT_MS
  };
}

export function defineAcpConnectionProviderContract(
  name: string,
  createProvider: () => AcpConnectionProvider
): void {
  describe(`${name} ACP connection provider contract`, () => {
    const leases: Array<{ processId: number | null; release: () => Promise<unknown> }> = [];

    afterEach(async () => {
      await Promise.all(
        leases.splice(0).map((item) =>
          item.release().finally(() => {
            if (item.processId !== null) expectProcessExited(item.processId);
          })
        )
      );
    });

    it("acquire creates a connection", async () => {
      const provider = createProvider();
      const lease = await provider.acquire(acquireRequest("success"));
      leases.push({
        processId: lease.processId,
        release: () =>
          lease.release({
            terminal: "failed",
            cleanupDeadline: createAcpCleanupDeadline(300)
          })
      });
      expect(lease.processId).toEqual(expect.any(Number));
      const initialized = await lease.initialize();
      expect(initialized.protocolVersion).toEqual(expect.any(Number));
    });

    it("openSession new works", async () => {
      const provider = createProvider();
      const lease = await provider.acquire(acquireRequest("success"));
      leases.push({
        processId: lease.processId,
        release: () =>
          lease.release({
            terminal: "succeeded",
            cleanupDeadline: createAcpCleanupDeadline(300)
          })
      });
      await lease.initialize();
      const session = await lease.openSession({ kind: "new" });
      expect(session.sessionId).toMatch(/^mock-session-/);
    });

    it("prompt and cancel go through the owned session", async () => {
      const provider = createProvider();
      const lease = await provider.acquire(acquireRequest("success"));
      leases.push({
        processId: lease.processId,
        release: () =>
          lease.release({
            terminal: "cancelled",
            cleanupDeadline: createAcpCleanupDeadline(300)
          })
      });
      await lease.initialize();
      const session = await lease.openSession({ kind: "new" });
      const prompted = session.prompt([{ type: "text", text: "hello" }]);
      await session.cancel();
      await expect(prompted).resolves.toMatchObject({ stopReason: expect.any(String) });
    });

    it("release closes if advertised then disposes", async () => {
      const provider = createProvider();
      const lease = await provider.acquire(acquireRequest("close-capable"));
      const processId = lease.processId;
      await lease.initialize();
      expect(lease.advertised.closeSession).toBe(true);
      await lease.openSession({ kind: "new" });
      const released = await lease.release({
        terminal: "succeeded",
        cleanupDeadline: createAcpCleanupDeadline(300)
      });
      expect(released).toMatchObject({ closedSession: true, disposed: true, failures: [] });
      if (processId === null) throw new Error("ACP provider contract process id is missing.");
      expectProcessExited(processId);
    });

    it("release without session-close still disposes", async () => {
      const provider = createProvider();
      const lease = await provider.acquire(acquireRequest("success"));
      const processId = lease.processId;
      await lease.initialize();
      expect(lease.advertised.closeSession).toBe(false);
      await lease.openSession({ kind: "new" });
      const released = await lease.release({
        terminal: "succeeded",
        cleanupDeadline: createAcpCleanupDeadline(300)
      });
      expect(released).toMatchObject({ closedSession: false, disposed: true, failures: [] });
      if (processId === null) throw new Error("ACP provider contract process id is missing.");
      expectProcessExited(processId);
    });

    it("release is idempotent and unusable afterwards", async () => {
      const provider = createProvider();
      const lease = await provider.acquire(acquireRequest("success"));
      const processId = lease.processId;
      await lease.initialize();
      const session = await lease.openSession({ kind: "new" });
      const first = await lease.release({
        terminal: "succeeded",
        cleanupDeadline: createAcpCleanupDeadline(300)
      });
      const second = await lease.release({
        terminal: "failed",
        cleanupDeadline: createAcpCleanupDeadline(300)
      });
      expect(second).toEqual(first);
      await expect(lease.initialize()).rejects.toBeInstanceOf(AcpLeaseReleasedError);
      await expect(
        session.prompt([{ type: "text", text: "after release" }])
      ).rejects.toBeInstanceOf(AcpLeaseReleasedError);
      if (processId === null) throw new Error("ACP provider contract process id is missing.");
      expectProcessExited(processId);
    });
  });
}

defineAcpConnectionProviderContract("dedicated", createDedicatedAcpConnectionProvider);
