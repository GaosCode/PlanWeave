import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAcpCleanupDeadline } from "../autoRun/acpExecutionCleanup.js";
import { shutdownAcpProcess } from "../autoRun/acpProcessShutdown.js";
import {
  attachManagedProcessTree,
  createFakeProcessTreeAdapter,
  type ManagedProcessTree
} from "../process/managedProcessTree.js";

describe("ACP process shutdown sequencing", () => {
  afterEach(() => vi.useRealTimers());

  it("uses one controlled deadline for EOF, TERM, force, and whole-tree confirmation", async () => {
    let now = 0;
    let descendantAlive = true;
    const events: string[] = [];
    const child = {
      exitCode: 0,
      signalCode: null,
      once() {
        return child;
      }
    } as unknown as ChildProcessWithoutNullStreams;
    const adapter = createFakeProcessTreeAdapter({
      isAlive: () => false,
      isTreeAlive: () => descendantAlive,
      onGraceful: () => events.push("term"),
      onForce: () => {
        events.push("force");
        descendantAlive = false;
      }
    });
    const tree = attachManagedProcessTree({
      child,
      pid: 70_001,
      adapter,
      graceMs: 999,
      forceExitConfirmMs: 999
    });
    const deadline = createAcpCleanupDeadline(600, () => now);
    const shutdown = shutdownAcpProcess({
      policy: { eofDrainMs: 100, terminateGraceMs: 150, cleanupDeadlineMs: 600 },
      deadline,
      closeInput: () => events.push("eof"),
      waitForRootExit: async (timeoutMs) => {
        events.push(`eof-wait:${timeoutMs}`);
        now += timeoutMs;
        return false;
      },
      processTree: tree
    });

    await shutdown;

    expect(events).toEqual(["eof", "eof-wait:100", "term", "force"]);
    now += 150;
    expect(deadline.remainingMs()).toBe(350);
    await expect(tree.isTreeAlive()).resolves.toBe(false);
  });

  it("preserves the caller's cutoff across delayed termination and async adapter work", async () => {
    let now = 0;
    let descendantAlive = true;
    const waits: number[] = [];
    const child = {
      exitCode: 0,
      signalCode: null,
      once() {
        return child;
      }
    } as ChildProcessWithoutNullStreams;
    const deadline = createAcpCleanupDeadline(300, () => now);
    const tree = attachManagedProcessTree({
      child,
      pid: 70_002,
      adapter: {
        ...createFakeProcessTreeAdapter({
          isAlive: () => false,
          isTreeAlive: () => descendantAlive,
          onGraceful: async () => {
            now += 30;
            await Promise.resolve();
            throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
          },
          awaitTreeExit: async (_pid, timeoutMs) => {
            waits.push(timeoutMs);
            descendantAlive = false;
            return true;
          }
        }),
        name: "posix"
      }
    });
    const delayedTree: ManagedProcessTree = {
      ...tree,
      terminate(reason, options) {
        expect(options?.deadline).toBe(deadline);
        now += 100;
        return tree.terminate(reason, options);
      }
    };

    await shutdownAcpProcess({
      policy: { eofDrainMs: 25, terminateGraceMs: 25, cleanupDeadlineMs: 300 },
      deadline,
      closeInput() {},
      waitForRootExit: async (timeoutMs) => {
        now += timeoutMs;
        return false;
      },
      processTree: delayedTree
    });

    expect(waits).toEqual([145]);
    expect(deadline.remainingMs()).toBe(145);
    await expect(tree.isTreeAlive()).resolves.toBe(false);
  });

  it("reports cleanup failure when the shared cutoff expires during tree confirmation", async () => {
    let now = 0;
    const deadline = createAcpCleanupDeadline(300, () => now);
    const tree: ManagedProcessTree = {
      pid: 70_003,
      exited: Promise.resolve(),
      isAlive: () => false,
      isTreeAlive: async () => false,
      awaitTreeExit: async () => true,
      terminate: async (reason) => {
        now = 300;
        return { outcome: "already_exited", reason };
      }
    };

    await expect(
      shutdownAcpProcess({
        policy: { eofDrainMs: 25, terminateGraceMs: 25, cleanupDeadlineMs: 300 },
        deadline,
        closeInput() {},
        waitForRootExit: async () => true,
        processTree: tree
      })
    ).rejects.toThrow("exceeded the configured cleanup deadline");
  });
});
