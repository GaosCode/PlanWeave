import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { observeRunnerRecordFiles } from "../autoRun/runnerRecordFileObserver.js";
import { createTestWorkspace } from "./promptTestHelpers.js";

describe("runner record file observer", () => {
  it("uses watch as a hint, polls as fallback, and releases watcher/timer on terminal", async () => {
    const { init } = await createTestWorkspace();
    const runDir = join(init.workspace.resultsDir, "observer-run");
    await mkdir(runDir, { recursive: true });
    const closeWatcher = vi.fn();
    let watchHint: (() => void) | null = null;
    let poll: (() => void) | null = null;
    const clearInterval = vi.fn();
    let terminal = false;
    let sequence = 0;
    const updates: number[] = [];
    const subscription = observeRunnerRecordFiles({
      runDir,
      watchDirectory: (_path, listener) => {
        watchHint = listener;
        return { close: closeWatcher };
      },
      setInterval: ((listener: () => void) => {
        poll = listener;
        return { unref: vi.fn() };
      }) as typeof globalThis.setInterval,
      clearInterval: clearInterval as typeof globalThis.clearInterval,
      refresh: async () => ({ value: ++sequence, terminal, sequence }),
      onUpdate: (value) => {
        updates.push(value);
      }
    });

    await vi.waitFor(() => expect(updates).toEqual([1]));
    poll?.();
    await vi.waitFor(() => expect(updates).toEqual([1, 2]));
    terminal = true;
    watchHint?.();
    await expect(subscription.closed).resolves.toMatchObject({ reason: "terminal" });
    expect(updates).toEqual([1, 2, 3]);
    expect(clearInterval).toHaveBeenCalledOnce();
    expect(closeWatcher).toHaveBeenCalledOnce();
  });

  it("cleans resources after explicit unsubscribe", async () => {
    const { init } = await createTestWorkspace();
    const runDir = join(init.workspace.resultsDir, "observer-unsubscribe");
    await mkdir(runDir, { recursive: true });
    const closeWatcher = vi.fn();
    const clearInterval = vi.fn();
    const onUpdate = vi.fn();
    const subscription = observeRunnerRecordFiles({
      runDir,
      watchDirectory: () => ({ close: closeWatcher }),
      setInterval: (() => ({ unref: vi.fn() })) as typeof globalThis.setInterval,
      clearInterval: clearInterval as typeof globalThis.clearInterval,
      refresh: async () => ({ value: 1, terminal: false, sequence: 0 }),
      onUpdate
    });
    await vi.waitFor(() => expect(onUpdate).toHaveBeenCalledOnce());
    subscription.unsubscribe();
    await expect(subscription.closed).resolves.toMatchObject({ reason: "explicit_unsubscribe" });
    expect(clearInterval).toHaveBeenCalledOnce();
    expect(closeWatcher).toHaveBeenCalledOnce();
  });

  it("does not register a watcher or publish after unsubscribe wins an in-flight directory read", async () => {
    const { init } = await createTestWorkspace();
    const runDir = join(init.workspace.resultsDir, "observer-read-race");
    await mkdir(runDir, { recursive: true });
    let resolveRead!: (entries: []) => void;
    const readDirectory = vi.fn(
      () =>
        new Promise<[]>((resolve) => {
          resolveRead = resolve;
        })
    );
    const watchDirectory = vi.fn(() => ({ close: vi.fn() }));
    const onUpdate = vi.fn();
    const subscription = observeRunnerRecordFiles({
      runDir,
      readDirectory,
      watchDirectory,
      setInterval: (() => ({ unref: vi.fn() })) as typeof globalThis.setInterval,
      clearInterval: vi.fn() as typeof globalThis.clearInterval,
      refresh: async () => ({ value: 1, terminal: false, sequence: 1 }),
      onUpdate
    });
    await vi.waitFor(() => expect(readDirectory).toHaveBeenCalledOnce());
    subscription.unsubscribe();
    resolveRead([]);
    await expect(subscription.closed).resolves.toMatchObject({ reason: "explicit_unsubscribe" });
    await Promise.resolve();
    expect(watchDirectory).not.toHaveBeenCalled();
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("serializes watcher errors into owner disposal and cleans every resource", async () => {
    const { init } = await createTestWorkspace();
    const runDir = join(init.workspace.resultsDir, "observer-watch-error");
    await mkdir(runDir, { recursive: true });
    const closeWatcher = vi.fn();
    const clearInterval = vi.fn();
    let watcherError: ((error: Error) => void) | null = null;
    const onUpdate = vi.fn();
    const subscription = observeRunnerRecordFiles({
      runDir,
      readDirectory: async () => [],
      watchDirectory: (_path, _onChange, onError) => {
        watcherError = onError;
        return { close: closeWatcher };
      },
      setInterval: (() => ({ unref: vi.fn() })) as typeof globalThis.setInterval,
      clearInterval: clearInterval as typeof globalThis.clearInterval,
      refresh: async () => ({ value: 1, terminal: false, sequence: 4 }),
      onUpdate
    });
    await vi.waitFor(() => expect(onUpdate).toHaveBeenCalledOnce());
    watcherError?.(new Error("watch failed"));
    await expect(subscription.closed).resolves.toMatchObject({
      reason: "owner_disposed",
      lastSequence: 4,
      message: expect.stringContaining("watch failed")
    });
    expect(clearInterval).toHaveBeenCalledOnce();
    expect(closeWatcher).toHaveBeenCalledTimes(2);
  });
});
