import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAcpCleanupDeadline } from "../autoRun/acpExecutionCleanup.js";
import { shutdownAcpProcess } from "../autoRun/acpProcessShutdown.js";
import {
  attachManagedProcessTree,
  createFakeProcessTreeAdapter
} from "../process/managedProcessTree.js";

describe("ACP process shutdown sequencing", () => {
  afterEach(() => vi.useRealTimers());

  it("uses one controlled deadline for EOF, TERM, force, and whole-tree confirmation", async () => {
    vi.useFakeTimers();
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

    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual(["eof", "eof-wait:100", "term"]);
    now += 150;
    await vi.runAllTimersAsync();
    await shutdown;

    expect(events).toEqual(["eof", "eof-wait:100", "term", "force"]);
    expect(deadline.remainingMs()).toBe(350);
    await expect(tree.isTreeAlive()).resolves.toBe(false);
  });
});
