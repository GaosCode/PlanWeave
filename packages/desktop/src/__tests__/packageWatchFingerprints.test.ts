import { describe, expect, it } from "vitest";
import {
  mapWithBoundedConcurrency,
  preserveContentHashes,
  type PackageFingerprintSnapshot
} from "../main/packageWatchFingerprints";

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolveDeferred!: (value: T) => void;
  let rejectDeferred!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolveDeferred = resolve;
    rejectDeferred = reject;
  });
  return { promise, resolve: resolveDeferred, reject: rejectDeferred };
}

describe("packageWatchFingerprints", () => {
  it("preserveContentHashes keeps hash when mtime and size are unchanged", () => {
    const previous: PackageFingerprintSnapshot = new Map([
      ["package/nodes/a.md", { mtimeMs: 10, size: 4, hash: "abc" }],
      ["package/nodes/b.md", { mtimeMs: 20, size: 8, hash: "def" }]
    ]);
    const next: PackageFingerprintSnapshot = new Map([
      ["package/nodes/a.md", { mtimeMs: 10, size: 4 }],
      ["package/nodes/b.md", { mtimeMs: 21, size: 8 }]
    ]);

    preserveContentHashes(previous, next);

    expect(next.get("package/nodes/a.md")?.hash).toBe("abc");
    expect(next.get("package/nodes/b.md")?.hash).toBeUndefined();
  });

  it("mapWithBoundedConcurrency waits for active workers before rejecting", async () => {
    const items = [0, 1, 2, 3];
    const deferreds = items.map(() => createDeferred<number>());
    let maxActive = 0;
    let active = 0;
    let settledEarly = false;

    const run = mapWithBoundedConcurrency(items, 4, async (item) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        return await deferreds[item].promise;
      } finally {
        active -= 1;
      }
    });

    // Reject one worker while others remain pending.
    deferreds[0].reject(new Error("read failed"));
    await Promise.resolve();
    await Promise.resolve();

    let rejected = false;
    void run.then(
      () => {
        settledEarly = true;
      },
      () => {
        rejected = true;
      }
    );
    await Promise.resolve();
    expect(settledEarly).toBe(false);
    expect(rejected).toBe(false);
    expect(active).toBe(3);
    expect(maxActive).toBe(4);

    deferreds[1].resolve(1);
    deferreds[2].resolve(2);
    deferreds[3].resolve(3);
    await expect(run).rejects.toThrow("read failed");
    expect(active).toBe(0);
  });

  it("mapWithBoundedConcurrency never schedules beyond the limit after a failure", async () => {
    const items = [0, 1, 2, 3, 4, 5];
    const started: number[] = [];
    const deferreds = items.map(() => createDeferred<number>());

    const run = mapWithBoundedConcurrency(items, 4, async (item) => {
      started.push(item);
      return deferreds[item].promise;
    });

    await Promise.resolve();
    expect(started).toEqual([0, 1, 2, 3]);

    deferreds[1].reject(new Error("boom"));
    await Promise.resolve();
    // Still only the first wave; no 4/5 scheduled after failure.
    expect(started).toEqual([0, 1, 2, 3]);

    deferreds[0].resolve(0);
    deferreds[2].resolve(2);
    deferreds[3].resolve(3);
    await expect(run).rejects.toThrow("boom");
    expect(started).toEqual([0, 1, 2, 3]);
  });

  it("mapWithBoundedConcurrency rejects falsy rejection reasons", async () => {
    await expect(
      mapWithBoundedConcurrency([1], 1, async () => Promise.reject(undefined))
    ).rejects.toBeUndefined();

    await expect(
      mapWithBoundedConcurrency([1], 1, async () => Promise.reject(null))
    ).rejects.toBeNull();

    await expect(mapWithBoundedConcurrency([1], 1, async () => Promise.reject(false))).rejects.toBe(
      false
    );
  });
});
