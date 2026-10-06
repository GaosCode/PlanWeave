import { afterEach, describe, expect, it, vi } from "vitest";
import { RemoteCoordinationMaintenance } from "../remoteCoordinationMaintenance.js";
import type { RemoteOperationRetentionResult } from "../remoteOperationRetention.js";

const empty = { selected: 0, compacted: 0, skipped: 0 };
const compacted = { selected: 1, compacted: 1, skipped: 0 };

afterEach(() => {
  vi.useRealTimers();
});

describe("RemoteCoordinationMaintenance", () => {
  it("reconciles periodically without overlapping and drains the active pass on close", async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    const reconcile = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const maintenance = new RemoteCoordinationMaintenance(reconcile, 1_000);
    maintenance.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reconcile).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(reconcile).toHaveBeenCalledTimes(1);
    let closed = false;
    const closing = maintenance.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    release?.();
    await closing;
    maintenance.start();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports an unresolved reconciliation failure but clears it after a successful retry", async () => {
    vi.useFakeTimers();
    const reconcile = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("reconcile failed"))
      .mockResolvedValue(undefined);
    const maintenance = new RemoteCoordinationMaintenance(reconcile, 1_000);
    maintenance.start();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(reconcile).toHaveBeenCalledTimes(2);
    await maintenance.close();
    const failed = new RemoteCoordinationMaintenance(async () => {
      throw new Error("unresolved reconcile");
    }, 1_000);
    failed.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(failed.close()).rejects.toThrow("unresolved reconcile");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("separates retention from fifteen-second heartbeats and caps empty-page backoff", async () => {
    vi.useFakeTimers();
    const reconcile = vi.fn(async () => undefined);
    const compact = vi.fn(() => empty);
    const maintenance = new RemoteCoordinationMaintenance(reconcile, 15_000, compact);
    maintenance.start();
    maintenance.start();
    expect(compact).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reconcile).toHaveBeenCalledTimes(4);
    expect(compact).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(compact).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(240_000);
    expect(compact).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(compact).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(compact).toHaveBeenCalledTimes(5);
    expect(reconcile).toHaveBeenCalledTimes(68);
    await maintenance.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("continues after work and recovers from a retention failure without poisoning close", async () => {
    vi.useFakeTimers();
    const compact = vi
      .fn<() => RemoteOperationRetentionResult>()
      .mockReturnValueOnce(empty)
      .mockReturnValueOnce(compacted)
      .mockImplementationOnce(() => {
        throw new Error("transient retention");
      })
      .mockReturnValue(compacted);
    const maintenance = new RemoteCoordinationMaintenance(async () => undefined, 15_000, compact);
    maintenance.start();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(compact).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(compact).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(compact).toHaveBeenCalledTimes(4);
    await maintenance.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps urgent coordination alive during a slow retention pass, drains on close, and queues no ticks", async () => {
    vi.useFakeTimers();
    let resolve: ((result: RemoteOperationRetentionResult) => void) | undefined;
    const compact = vi.fn(
      () =>
        new Promise<RemoteOperationRetentionResult>((done) => {
          resolve = done;
        })
    );
    const reconcile = vi.fn(async () => undefined);
    const maintenance = new RemoteCoordinationMaintenance(reconcile, 15_000, compact);
    maintenance.start();
    await vi.advanceTimersByTimeAsync(660_000);
    expect(compact).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(44);
    let closed = false;
    const closing = maintenance.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    resolve?.(compacted);
    await closing;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(compact).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(44);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports a failed in-flight retention pass when closing", async () => {
    vi.useFakeTimers();
    let reject: ((error: Error) => void) | undefined;
    const maintenance = new RemoteCoordinationMaintenance(
      async () => undefined,
      15_000,
      () =>
        new Promise<RemoteOperationRetentionResult>((_, fail) => {
          reject = fail;
        })
    );
    maintenance.start();
    await vi.advanceTimersByTimeAsync(60_000);
    const closing = maintenance.close();
    const failure = expect(closing).rejects.toThrow("retention failed");
    reject?.(new Error("retention failed"));
    await failure;
    expect(vi.getTimerCount()).toBe(0);
  });
  it("reports both unresolved lanes when coordination and retention fail", async () => {
    vi.useFakeTimers();
    const maintenance = new RemoteCoordinationMaintenance(
      async () => {
        throw new Error("coordination failure");
      },
      15_000,
      () => {
        throw new Error("retention failure");
      }
    );
    maintenance.start();
    await vi.advanceTimersByTimeAsync(60_000);
    let failure: unknown;
    try {
      await maintenance.close();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw new Error("Expected both maintenance failures");
    expect(failure.errors.map((error) => error.message)).toEqual([
      "coordination failure",
      "retention failure"
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
