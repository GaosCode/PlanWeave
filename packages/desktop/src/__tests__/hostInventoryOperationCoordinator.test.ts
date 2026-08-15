import { describe, expect, it, vi } from "vitest";
import { createHostInventoryOperationCoordinator } from "../renderer/settings/hostInventoryOperationCoordinator";

function deferred() {
  let resolve!: () => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<void>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

describe("Host inventory operation coordinator", () => {
  it("keeps one promise identity when a queued mode becomes active", async () => {
    const coordinator = createHostInventoryOperationCoordinator();
    const activeGate = deferred();
    const queuedGate = deferred();
    const queuedOperation = vi.fn(() => queuedGate.promise);

    const activePromise = coordinator.run("authority-a", "refresh", () => activeGate.promise);
    const queuedPromise = coordinator.run("authority-a", "continue", queuedOperation);
    expect(queuedOperation).not.toHaveBeenCalled();

    activeGate.resolve();
    await activePromise;
    expect(queuedOperation).toHaveBeenCalledOnce();
    expect(coordinator.run("authority-a", "continue", () => Promise.resolve())).toBe(queuedPromise);

    queuedGate.resolve();
    await queuedPromise;
  });

  it("continues a queued job after rejection and allows the lane to be reused", async () => {
    const coordinator = createHostInventoryOperationCoordinator();
    const activeGate = deferred();
    const queuedOperation = vi.fn(() => Promise.resolve());
    const activePromise = coordinator.run("authority-a", "refresh", () => activeGate.promise);
    const activeRejection = expect(activePromise).rejects.toThrow("read failed");
    const queuedPromise = coordinator.run("authority-a", "continue", queuedOperation);

    activeGate.reject(new Error("read failed"));
    await activeRejection;
    await expect(queuedPromise).resolves.toBeUndefined();
    expect(queuedOperation).toHaveBeenCalledOnce();

    const reusedOperation = vi.fn(() => Promise.resolve());
    await expect(
      coordinator.run("authority-a", "refresh", reusedOperation)
    ).resolves.toBeUndefined();
    expect(reusedOperation).toHaveBeenCalledOnce();
  });

  it("runs different authority lanes independently", async () => {
    const coordinator = createHostInventoryOperationCoordinator();
    const authorityAGate = deferred();
    const authorityBGate = deferred();
    const authorityAOperation = vi.fn(() => authorityAGate.promise);
    const authorityBOperation = vi.fn(() => authorityBGate.promise);

    const authorityAPromise = coordinator.run("authority-a", "refresh", authorityAOperation);
    const authorityBPromise = coordinator.run("authority-b", "refresh", authorityBOperation);
    expect(authorityAOperation).toHaveBeenCalledOnce();
    expect(authorityBOperation).toHaveBeenCalledOnce();

    authorityBGate.resolve();
    await authorityBPromise;
    expect(authorityAOperation).toHaveBeenCalledOnce();

    authorityAGate.resolve();
    await authorityAPromise;
  });
});
