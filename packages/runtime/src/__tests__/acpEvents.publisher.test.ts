import { appendFile, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  AcpEventPublisher,
  acpEventSubscriptionCloseRecoverable,
  acpEventSubscriptionCloseResultSchema,
  createAcpEventSubscriptionCloseResult
} from "../autoRun/acpEventPublisher.js";
import { AcpEventStore } from "../autoRun/acpEventStore.js";
import { normalizedRunnerEventSchema } from "../autoRun/normalizedEventContract.js";
import { runnerIdentitySchema } from "../autoRun/runnerContractSchemas.js";
import { event, identity } from "./acpEvents.helpers.js";

describe("ACP event publisher", () => {
  it("rejects close results whose recoverable flag disagrees with reason policy", () => {
    expect(() =>
      acpEventSubscriptionCloseResultSchema.parse({
        reason: "not_subscribable",
        lastSequence: 0,
        recoverable: true,
        message: "must not reconnect"
      })
    ).toThrow(/recoverable must be false/);
    expect(() =>
      acpEventSubscriptionCloseResultSchema.parse({
        reason: "subscriber_backpressure",
        lastSequence: 1,
        recoverable: false,
        message: "must be recoverable"
      })
    ).toThrow(/recoverable must be true/);
    const factory = createAcpEventSubscriptionCloseResult("not_subscribable", 3, "disk replay");
    expect(factory.recoverable).toBe(false);
    expect(acpEventSubscriptionCloseRecoverable("not_subscribable")).toBe(false);
    expect(acpEventSubscriptionCloseResultSchema.parse(factory)).toEqual(factory);
  });

  it("atomically replays then delivers live events once and tears down at terminal", async () => {
    const publisher = new AcpEventPublisher();
    publisher.seed([event(1)]);
    const received: number[] = [];
    const subscription = publisher.subscribe(0, async (item) => {
      received.push(item.sequence);
    });
    publisher.publish(event(1));
    publisher.publish(event(2));
    publisher.publish(
      normalizedRunnerEventSchema.parse({
        ...event(3),
        body: {
          kind: "terminal",
          outcome: {
            version: "planweave.runner/v1",
            state: "succeeded",
            exitCode: 0,
            finishedAt: "2026-07-11T00:00:01.000Z",
            diagnostic: null,
            artifactValidated: true
          }
        }
      })
    );
    await subscription.closed;
    expect(received).toEqual([1, 2, 3]);
    expect(publisher.subscriberCount).toBe(0);
  });

  it("isolates concurrent runs and unsubscribes bounded slow subscribers", async () => {
    const diagnostics: string[] = [];
    const first = new AcpEventPublisher(1, (code) => diagnostics.push(code));
    const second = new AcpEventPublisher();
    let release = (): void => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const subscription = first.subscribe(0, () => blocked);
    const other: string[] = [];
    second.subscribe(0, (item) => {
      other.push(item.identity.runId);
    });
    first.publish(event(1));
    first.publish(event(2));
    second.publish(event(1, "RUN-002"));
    release();
    const closeResult = await subscription.closed;
    expect(first.subscriberCount).toBe(0);
    expect(other).toEqual(["RUN-002"]);
    expect(diagnostics).toEqual(["subscriber_backpressure"]);
    expect(closeResult).toEqual({
      reason: "subscriber_backpressure",
      lastSequence: 1,
      recoverable: true,
      message: expect.stringContaining("exceeded 1 pending")
    });
  });

  it("supports explicit unsubscribe", async () => {
    const publisher = new AcpEventPublisher();
    const subscription = publisher.subscribe(0, () => undefined);
    subscription.unsubscribe();
    await expect(subscription.closed).resolves.toEqual({
      reason: "explicit_unsubscribe",
      lastSequence: 0,
      recoverable: false,
      message: expect.any(String)
    });
    expect(publisher.subscriberCount).toBe(0);
  });

  it("replays a seeded terminal and closes without retaining the subscriber", async () => {
    const terminal = normalizedRunnerEventSchema.parse({
      ...event(2),
      body: {
        kind: "terminal",
        outcome: {
          version: "planweave.runner/v1",
          state: "succeeded",
          exitCode: 0,
          finishedAt: "2026-07-11T00:00:01.000Z",
          diagnostic: null,
          artifactValidated: true
        }
      }
    });
    const publisher = new AcpEventPublisher();
    publisher.seed([event(1), terminal]);
    const received: number[] = [];
    const subscription = publisher.subscribe(0, (item) => {
      received.push(item.sequence);
    });
    await subscription.closed;
    expect(received).toEqual([1, 2]);
    expect(publisher.subscriberCount).toBe(0);
  });

  it("keeps an explicit conversation subscriber open after executor terminal", async () => {
    const terminal = normalizedRunnerEventSchema.parse({
      ...event(2),
      body: {
        kind: "terminal",
        outcome: {
          version: "planweave.runner/v1",
          state: "succeeded",
          exitCode: 0,
          finishedAt: "2026-07-11T00:00:01.000Z",
          diagnostic: null,
          artifactValidated: true
        }
      }
    });
    const publisher = new AcpEventPublisher();
    publisher.seed([event(1), terminal]);
    const received: number[] = [];
    const subscription = publisher.subscribe(
      2,
      (item) => {
        received.push(item.sequence);
      },
      {
        keepOpenAfterTerminal: true
      }
    );

    publisher.publish(event(3));
    await Promise.resolve();
    subscription.unsubscribe();
    await subscription.closed;

    expect(received).toEqual([3]);
    expect(publisher.subscriberCount).toBe(0);
  });

  it("captures subscriber rejection, closes it, and avoids an unhandled chain", async () => {
    const diagnostics: string[] = [];
    const publisher = new AcpEventPublisher(10, (code) => {
      diagnostics.push(code);
    });
    const subscription = publisher.subscribe(0, async () => {
      throw new Error("consumer failed");
    });
    publisher.publish(event(1));
    const closeResult = await subscription.closed;
    await publisher.drainDiagnostics();
    expect(diagnostics).toEqual(["subscriber_callback_failed"]);
    expect(publisher.subscriberCount).toBe(0);
    expect(closeResult).toEqual({
      reason: "subscriber_callback_failed",
      lastSequence: 1,
      recoverable: true,
      message: expect.stringContaining("consumer failed")
    });
  });

  it("keeps the original close reason when the diagnostic sink fails", async () => {
    const publisher = new AcpEventPublisher(10, async () => {
      throw new Error("diagnostic sink unavailable");
    });
    const subscription = publisher.subscribe(0, async () => {
      throw new Error("callback boom");
    });
    publisher.publish(event(1));
    const closeResult = await subscription.closed;
    await publisher.drainDiagnostics();
    expect(closeResult.reason).toBe("subscriber_callback_failed");
    expect(closeResult.recoverable).toBe(true);
    expect(closeResult.message).toContain("callback boom");
    expect(publisher.diagnostics).toContainEqual(
      expect.objectContaining({ code: "diagnostic_sink_failed" })
    );
  });

  it("resolves terminal close-result once and does not mark it recoverable", async () => {
    const publisher = new AcpEventPublisher();
    const subscription = publisher.subscribe(0, () => undefined);
    publisher.publish(event(1));
    publisher.publish(
      normalizedRunnerEventSchema.parse({
        ...event(2),
        body: {
          kind: "terminal",
          outcome: {
            version: "planweave.runner/v1",
            state: "succeeded",
            exitCode: 0,
            finishedAt: "2026-07-11T00:00:01.000Z",
            diagnostic: null,
            artifactValidated: true
          }
        }
      })
    );
    const closeResult = await subscription.closed;
    subscription.unsubscribe();
    const second = await subscription.closed;
    expect(closeResult).toEqual({
      reason: "terminal",
      lastSequence: 2,
      recoverable: false,
      message: expect.any(String)
    });
    expect(second).toBe(closeResult);
  });

  it("isolates a diagnostic sink failure and reports later subscriber failures", async () => {
    let attempts = 0;
    const publisher = new AcpEventPublisher(10, async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("diagnostic sink unavailable");
    });
    const first = publisher.subscribe(0, async () => {
      throw new Error("first subscriber failed");
    });
    publisher.publish(event(1));
    await first.closed;
    await publisher.drainDiagnostics();

    const second = publisher.subscribe(1, async () => {
      throw new Error("second subscriber failed");
    });
    publisher.publish(event(2));
    await second.closed;
    await publisher.drainDiagnostics();

    expect(attempts).toBe(2);
    expect(publisher.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "diagnostic_sink_failed"
      })
    );
  });

  it("keeps healthy subscribers and later events flowing after one subscriber fails", async () => {
    const publisher = new AcpEventPublisher();
    const failed = publisher.subscribe(0, async () => {
      throw new Error("subscriber-local failure");
    });
    const received: number[] = [];
    const healthy = publisher.subscribe(0, (item) => {
      received.push(item.sequence);
    });
    publisher.publish(event(1));
    await failed.closed;
    publisher.publish(event(2));
    healthy.unsubscribe();
    await healthy.closed;
    await publisher.drainDiagnostics();
    expect(received).toEqual([1, 2]);
    expect(publisher.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "subscriber_callback_failed"
      })
    );
  });

  it("persists backpressure diagnostics through the store sink", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-acp-backpressure-"));
    const publisher = new AcpEventPublisher(1);
    const store = new AcpEventStore({
      runDir,
      identity: identity(),
      publisher,
      runner: runnerIdentitySchema.parse({
        version: "planweave.runner/v1",
        runnerKind: "acp",
        agentId: "codex"
      })
    });
    await store.open();
    let release = (): void => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const subscription = publisher.subscribe(0, () => blocked);
    await store.append(event(1).body);
    await store.append(event(2).body);
    release();
    await subscription.closed;
    await store.drain();
    expect(await readFile(store.eventsPath, "utf8")).toContain("subscriber_backpressure");
  });

  it("keeps the run healthy when one subscriber diagnostic cannot be persisted", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-acp-diagnostic-sink-failure-"));
    let failDiagnostic = true;
    const publisher = new AcpEventPublisher();
    const store = new AcpEventStore({
      runDir,
      identity: identity(),
      publisher,
      runner: runnerIdentitySchema.parse({
        version: "planweave.runner/v1",
        runnerKind: "acp",
        agentId: "codex"
      }),
      appendText: async (path, data, options) => {
        if (failDiagnostic && String(data).includes("subscriber_callback_failed")) {
          failDiagnostic = false;
          throw new Error("diagnostic append unavailable");
        }
        await appendFile(path, data, options);
      }
    });
    await store.open();
    const failed = publisher.subscribe(0, async () => {
      throw new Error("subscriber-local failure");
    });
    await store.append(event(1).body);
    await failed.closed;
    await expect(store.drain()).resolves.toBeUndefined();
    expect(store.snapshot().diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "subscriber_callback_failed" }),
        expect.objectContaining({ code: "publisher_failed" })
      ])
    );

    const laterFailure = publisher.subscribe(1, async () => {
      throw new Error("later subscriber-local failure");
    });
    await store.append(event(2).body);
    await laterFailure.closed;
    await expect(store.drain()).resolves.toBeUndefined();
    expect(await readFile(store.eventsPath, "utf8")).toContain("subscriber_callback_failed");
  });
});
