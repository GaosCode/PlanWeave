import { afterEach, describe, expect, it, vi } from "vitest";
import { AcpCleanupSequencer, createAcpCleanupDeadline } from "../autoRun/acpExecutionCleanup.js";

describe("ACP cleanup sequencing", () => {
  afterEach(() => vi.useRealTimers());

  it("lets the operation settle its own timeout before the same-cap safety boundary", async () => {
    vi.useFakeTimers();
    const cleanup = new AcpCleanupSequencer(createAcpCleanupDeadline(1_000, Date.now));
    const operationError = new Error("session/close timed out after 100ms");
    let terminated = false;
    const result = cleanup.run(
      "session close",
      (timeoutMs) =>
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => {
            terminated = true;
            reject(operationError);
          }, timeoutMs);
        }),
      100
    );
    const rejected = expect(result).rejects.toBe(operationError);
    await Promise.all([rejected, vi.advanceTimersByTimeAsync(100)]);
    expect(terminated).toBe(true);
    expect(cleanup.deadline.remainingMs()).toBe(900);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a never-settling step without claiming the total deadline expired", async () => {
    vi.useFakeTimers();
    const cleanup = new AcpCleanupSequencer(createAcpCleanupDeadline(1_000, Date.now));
    const rejected = expect(
      cleanup.run("session close", () => new Promise(() => undefined), 100)
    ).rejects.toThrow("ACP session close timed out after 100ms.");
    await Promise.all([rejected, vi.advanceTimersByTimeAsync(100)]);
    expect(cleanup.deadline.remainingMs()).toBe(900);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps one absolute deadline across steps and refuses work once it expires", async () => {
    vi.useFakeTimers();
    const cleanup = new AcpCleanupSequencer(createAcpCleanupDeadline(100, Date.now));
    await cleanup.run("first step", async (timeoutMs) => {
      expect(timeoutMs).toBe(100);
      await vi.advanceTimersByTimeAsync(60);
    });
    const rejected = expect(
      cleanup.run(
        "disposal",
        (timeoutMs) => {
          expect(timeoutMs).toBe(40);
          return new Promise(() => undefined);
        },
        100
      )
    ).rejects.toThrow("ACP disposal exceeded the cleanup deadline.");
    await Promise.all([rejected, vi.advanceTimersByTimeAsync(40)]);
    const operation = vi.fn(async () => undefined);
    await expect(cleanup.run("late disposal", operation)).rejects.toThrow("cleanup deadline");
    expect(operation).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not leave a safety timer after a synchronous operation throw", async () => {
    vi.useFakeTimers();
    const cleanup = new AcpCleanupSequencer(createAcpCleanupDeadline(100, Date.now));
    const failure = new Error("synchronous close failure");
    await expect(
      cleanup.run("session close", () => {
        throw failure;
      })
    ).rejects.toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
  });
});
