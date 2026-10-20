import { afterEach, describe, expect, it } from "vitest";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { createAcpConnection, type AcpConnection } from "../autoRun/acpConnection.js";
import { createDedicatedAcpConnectionLease } from "../autoRun/acpConnectionLease.js";
import { AcpCleanupSequencer, createAcpCleanupDeadline } from "../autoRun/acpExecutionCleanup.js";
import { acpShutdownPolicySchema } from "../acpProfile/schema.js";

const cleanupWaveCount = 3;
const concurrentConnectionsPerWave = 4;

function environment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
}

function expectProcessExited(processId: number): void {
  try {
    process.kill(processId, 0);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return;
    }
    throw error;
  }
  throw new Error(`ACP cleanup integration process ${processId} is still alive.`);
}

describe("ACP connection process cleanup", () => {
  const connections: AcpConnection[] = [];

  afterEach(async () => {
    await Promise.all(connections.splice(0).map((connection) => connection.dispose()));
  });

  it("loads the ACP lifecycle fixture without an executor registry import cycle", async () => {
    const { mockLaunch } = await import("./support/acpRunnerLifecycleFixture.js");

    expect(mockLaunch("stubborn-pending")).toMatchObject({
      command: process.execPath,
      source: { registryId: "codex-acp" }
    });
  });

  it.runIf(process.platform === "darwin").each([
    { owner: "connection disposal", precedingCleanupMs: 0 },
    { owner: "dedicated lease release after preceding cleanup", precedingCleanupMs: 100 }
  ])(
    "finishes $owner when EOF leaves the owned process group awaiting reap",
    async ({ precedingCleanupMs }) => {
      const controlDir = await mkdtemp(join(tmpdir(), "planweave-acp-eof-reap-"));
      const releasePath = join(controlDir, "release-exit");
      let observedExitWindow = false;
      let ownerCleanup: AcpCleanupSequencer | undefined;
      let terminationObservation:
        | {
            graceMs: number | null;
            confirmMs: number | null;
            originalRemainingMs: number | null;
            remainingAtManagedTerminateMs: number | null;
            expiresAt: number | null;
          }
        | undefined;
      const policy = acpShutdownPolicySchema.parse({
        eofDrainMs: 25,
        terminateGraceMs: 25,
        cleanupDeadlineMs: 300
      });
      const connection = createAcpConnection({
        launch: {
          trusted: true,
          command: process.execPath,
          args: [
            fileURLToPath(new URL("./support/posixEofExitBarrier.mjs", import.meta.url)),
            controlDir
          ]
        },
        cwd: process.cwd(),
        env: environment(),
        clientInfo: { name: "cleanup-integration", version: "1" },
        shutdown: policy,
        decorateProcessTree: (tree) => ({
          ...tree,
          terminate(reason, options) {
            terminationObservation = {
              graceMs: options?.graceMs ?? null,
              confirmMs: options?.forceExitConfirmMs ?? null,
              originalRemainingMs: options?.deadline?.remainingMs() ?? null,
              remainingAtManagedTerminateMs: null,
              expiresAt: options?.deadline?.expiresAt ?? null
            };
            expect(options?.deadline?.expiresAt).toBe(ownerCleanup?.deadline.expiresAt);
            expect(options?.deadline?.remainingMs).toBe(ownerCleanup?.deadline.remainingMs);
            if (precedingCleanupMs > 0) {
              expect(options?.graceMs).toBe(0);
              expect(options?.forceExitConfirmMs).toBeGreaterThan(0);
            }
            const deadline = performance.now() + 2_000;
            const wait = new Int32Array(new SharedArrayBuffer(4));
            while (!existsSync(join(controlDir, "eof")) && performance.now() < deadline) {
              Atomics.wait(wait, 0, 0, 1);
            }
            expect(existsSync(join(controlDir, "eof"))).toBe(true);
            writeFileSync(releasePath, "exit\n");
            // Keep libuv from reaping until Darwin exposes the exited group's state.
            while (performance.now() < deadline) {
              try {
                process.kill(-tree.pid, 0);
              } catch (error) {
                if (!(error instanceof Error) || !("code" in error) || error.code !== "EPERM") {
                  throw error;
                }
                observedExitWindow = true;
                break;
              }
              Atomics.wait(wait, 0, 0, 1);
            }
            expect(observedExitWindow).toBe(true);
            terminationObservation.remainingAtManagedTerminateMs =
              options?.deadline?.remainingMs() ?? null;
            return tree.terminate(reason, options);
          }
        })
      });
      connections.push(connection);
      try {
        const readyDeadline = performance.now() + 2_000;
        while (!existsSync(join(controlDir, "ready"))) {
          if (performance.now() >= readyDeadline)
            throw new Error("EOF fixture did not become ready.");
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
        }
        const cleanup = new AcpCleanupSequencer(createAcpCleanupDeadline(policy.cleanupDeadlineMs));
        ownerCleanup = cleanup;
        if (precedingCleanupMs > 0) {
          // Consume the owner's budget at the real sequencer boundary; this is a timing harness.
          await cleanup.run("preceding cleanup timing harness", async () => {
            await new Promise<void>((resolve) => setTimeout(resolve, precedingCleanupMs));
          });
          const lease = createDedicatedAcpConnectionLease(connection, process.cwd(), policy);
          const releaseInput = {
            terminal: "succeeded" as const,
            cleanupDeadline: cleanup.deadline
          };
          const released = await lease.release(releaseInput);
          console.info("ACP EOF lease release", {
            termination: terminationObservation,
            disposed: released.disposed,
            failures: released.failures.map((error) =>
              error instanceof Error ? error.message : String(error)
            ),
            remainingMs: cleanup.deadline.remainingMs()
          });
          expect(released).toEqual({ closedSession: false, disposed: true, failures: [] });
          expect(cleanup.deadline.remainingMs()).toBeGreaterThan(0);
          await expect(lease.release(releaseInput)).resolves.toBe(released);
        } else {
          await expect(
            connection.dispose({ cleanupDeadline: cleanup.deadline })
          ).resolves.toBeUndefined();
        }
        expect(observedExitWindow).toBe(true);
        const processId = connection.processId;
        if (processId === null) throw new Error("EOF fixture process id is missing.");
        expectProcessExited(processId);
        expect(() => process.kill(-processId, 0)).toThrowError(
          expect.objectContaining({ code: "ESRCH" })
        );
        await expect(connection.dispose()).resolves.toBeUndefined();
      } finally {
        writeFileSync(releasePath, "exit\n");
      }
    }
  );

  it("cancels a closed SDK connection before process exit and still reaps the live process", async () => {
    const connection = createAcpConnection({
      launch: {
        trusted: true,
        command: process.execPath,
        args: ["-e", "process.stdout.end(); setInterval(() => {}, 1000);"]
      },
      cwd: process.cwd(),
      env: environment(),
      clientInfo: { name: "cleanup-integration", version: "1" },
      shutdown: { eofDrainMs: 25, terminateGraceMs: 25, cleanupDeadlineMs: 300 }
    });
    connections.push(connection);

    await connection.closed;
    expect(connection.terminalFailure).toBeNull();
    const processId = connection.processId;
    if (processId === null) throw new Error("ACP cleanup integration process id is missing.");
    expect(() => process.kill(processId, 0)).not.toThrow();
    await expect(connection.cancel({ sessionId: "closed-session" })).resolves.toBeUndefined();
    await expect(connection.cancel({ sessionId: "closed-session" })).resolves.toBeUndefined();

    await expect(connection.dispose()).resolves.toBeUndefined();
    expectProcessExited(processId);
  });

  it("reaps repeated waves of concurrent SIGTERM-resistant process trees", async () => {
    const { fixture } = await import("./support/acpRunnerLifecycleFixture.js");

    for (let wave = 0; wave < cleanupWaveCount; wave += 1) {
      const current = Array.from({ length: concurrentConnectionsPerWave }, () => {
        const connection = createAcpConnection({
          launch: { trusted: true, command: process.execPath, args: [fixture, "stubborn-pending"] },
          cwd: process.cwd(),
          env: environment(),
          clientInfo: { name: "cleanup-integration", version: "1" },
          shutdown: { eofDrainMs: 25, terminateGraceMs: 25, cleanupDeadlineMs: 300 }
        });
        connections.push(connection);
        return connection;
      });
      await Promise.all(current.map((connection) => connection.initialize()));
      const processIds = current.map((connection) => connection.processId);
      expect(processIds).toEqual(processIds.map(() => expect.any(Number)));

      await expect(Promise.all(current.map((connection) => connection.dispose()))).resolves.toEqual(
        current.map(() => undefined)
      );

      for (const processId of processIds) {
        if (processId === null) {
          throw new Error("ACP cleanup integration process id is missing.");
        }
        expectProcessExited(processId);
      }
    }
  });
});
