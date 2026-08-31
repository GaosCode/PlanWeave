/**
 * REL-002#B-002 load / recovery matrix with explicit moderate-scale thresholds.
 *
 * Intended product scale: a few Hosts, a few concurrent eligible Blocks, bounded
 * event history, documented artifact/comment sizes — not internet-scale traffic.
 * Uses deterministic local multi-process harness (mock ACP). Live network tiers are
 * optional and never counted as pass when unavailable.
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RealProcessAcpHarness,
  type RealProcessAcpHarnessOptions
} from "./support/realProcessAcpHarness.js";
import { remoteAcpManifestParallelCapacity } from "./support/realProcessAcpManifests.js";
import { RealProcessLifecycleClient } from "./support/realProcessLifecycleClient.js";

/**
 * Moderate intended-scale and pass thresholds derived from current architecture:
 * - small team: 2 Hosts × capacity 1
 * - package concurrency: 2 eligible implementation blocks
 * - operator observe/dispatch over loopback HTTP
 * - fail on duplicate ACP session/new or silent double attempt
 */
export const LOAD_RECOVERY_THRESHOLDS = {
  hosts: 2,
  hostCapacityEach: 1,
  concurrentEligibleBlocks: 2,
  /** Dispatch accept (202 + observe leased/running) under local mock ACP. */
  maxDispatchLeasedMs: 20_000,
  /** Full terminal under mock ACP after resume/barrier. */
  maxTerminalMs: 90_000,
  /** Event replay page after terminal. */
  maxEventReplayMs: 5_000,
  /** Harness root growth after two completed blocks (SQLite + logs + workspace). */
  maxHarnessRootBytes: 80 * 1024 * 1024,
  /** Exactly one ACP session/new per successful attempt (no silent re-run). */
  maxSessionNewPerAttempt: 1,
  /** Capacity queue: second block may wait while first holds the only lease. */
  maxCapacityWaitMs: 30_000
} as const;

const harnesses: RealProcessAcpHarness[] = [];

afterEach(async () => {
  await Promise.all(
    harnesses.splice(0).map(async (harness) => {
      await harness.dispose();
    })
  );
});

async function createHarness(
  options: RealProcessAcpHarnessOptions = {}
): Promise<{ harness: RealProcessAcpHarness; client: RealProcessLifecycleClient }> {
  const harness = await RealProcessAcpHarness.create({
    acpScenario: "success",
    readinessTimeoutMs: 20_000,
    ...options
  });
  harnesses.push(harness);
  return { harness, client: new RealProcessLifecycleClient(harness, 120_000) };
}

async function directoryBytes(root: string): Promise<number> {
  let total = 0;
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      total += await directoryBytes(path);
      continue;
    }
    if (entry.isFile()) {
      total += (await stat(path)).size;
    }
  }
  return total;
}

describe("load / recovery matrix (moderate intended scale)", () => {
  it("two Hosts capacity 1: concurrent blocks complete without duplicate ACP or silent double attempt", async () => {
    const { harness, client } = await createHarness({
      hostCapacity: LOAD_RECOVERY_THRESHOLDS.hostCapacityEach,
      hostDisplayName: "Load Host A",
      manifest: remoteAcpManifestParallelCapacity()
    });
    await harness.startAll();
    const secondary = await harness.startSecondaryHost({
      key: "load-b",
      displayName: "Load Host B",
      capacity: LOAD_RECOVERY_THRESHOLDS.hostCapacityEach,
      capabilities: ["acp.codex"],
      acpScenario: "success"
    });
    expect(secondary.id).toEqual(expect.any(String));

    const hosts = await client.listHosts();
    expect(hosts.items.length).toBeGreaterThanOrEqual(LOAD_RECOVERY_THRESHOLDS.hosts);
    const primaryEndpoint = await client.availableAgentEndpointForHostDisplayName("Load Host A");
    const secondaryEndpoint = await client.availableAgentEndpointForHostDisplayName("Load Host B");
    expect(primaryEndpoint.endpointId).not.toBe(secondaryEndpoint.endpointId);
    expect(await client.availableAgentEndpoints()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ endpointId: primaryEndpoint.endpointId }),
        expect.objectContaining({ endpointId: secondaryEndpoint.endpointId })
      ])
    );

    const t0 = Date.now();
    const [first, second] = await Promise.all([
      client.dispatch({
        blockRef: "T-001#B-001",
        idempotencyKey: "load-concurrent-1",
        agentEndpointId: primaryEndpoint.endpointId
      }),
      client.dispatch({
        blockRef: "T-002#B-001",
        idempotencyKey: "load-concurrent-2",
        agentEndpointId: secondaryEndpoint.endpointId
      })
    ]);
    expect(first.operationId).not.toBe(second.operationId);
    expect(first.dispatchId).not.toBe(second.dispatchId);

    const terminalFirst = await client.waitForTerminal(first.operationId);
    const terminalSecond = await client.waitForTerminal(second.operationId);
    const terminalMs = Date.now() - t0;
    expect(terminalMs, `terminal wall ${terminalMs}ms`).toBeLessThanOrEqual(
      LOAD_RECOVERY_THRESHOLDS.maxTerminalMs
    );
    expect(terminalFirst.state).toBe("completed");
    expect(terminalSecond.state).toBe("completed");

    // No silent double execution: one attempt row and one session/new per block.
    expect(
      client.countServerRows("remote_execution_attempts", "operation_id IN (?,?)", [
        first.operationId,
        second.operationId
      ])
    ).toBe(2);
    // lifecycle.log is primary host only; count total ACP sessions via attempt rows instead
    // and ensure dispatches did not complete twice.
    expect(
      client.countServerRows("dispatches", "id IN (?,?) AND status='completed'", [
        first.dispatchId,
        second.dispatchId
      ])
    ).toBe(2);

    const replayStart = Date.now();
    const events = await client.listEvents(first.operationId, 0);
    const replayMs = Date.now() - replayStart;
    expect(replayMs, `event replay ${replayMs}ms`).toBeLessThanOrEqual(
      LOAD_RECOVERY_THRESHOLDS.maxEventReplayMs
    );
    expect(events.cursor).toBeGreaterThanOrEqual(0);
    expect(events.highWatermark).toBeGreaterThanOrEqual(events.cursor);
    // Monotonic: replaying from high watermark returns empty continuation.
    const empty = await client.listEvents(first.operationId, events.highWatermark);
    expect(empty.events).toEqual([]);

    const rootBytes = await directoryBytes(harness.paths.root);
    expect(rootBytes, `harness root ${rootBytes} bytes`).toBeLessThanOrEqual(
      LOAD_RECOVERY_THRESHOLDS.maxHarnessRootBytes
    );
  }, 180_000);

  it("Owner canvas concurrency admits 2 blocks even when collaboration Host capacity is 1", async () => {
    const { harness, client } = await createHarness({
      hostCapacity: 1,
      manifest: remoteAcpManifestParallelCapacity()
    });
    await harness.startAll();
    await harness.acpControl.pause(["session/prompt"]);
    const endpointId = await client.availableAgentEndpointId();

    const t0 = Date.now();
    const first = await client.dispatch({
      blockRef: "T-001#B-001",
      idempotencyKey: "load-cap-1",
      agentEndpointId: endpointId
    });
    await client.waitForDispatchStatus(first.operationId, ["leased", "running"]);
    const leasedMs = Date.now() - t0;
    expect(leasedMs, `first leased ${leasedMs}ms`).toBeLessThanOrEqual(
      LOAD_RECOVERY_THRESHOLDS.maxDispatchLeasedMs
    );

    const second = await client.dispatch({
      blockRef: "T-002#B-001",
      idempotencyKey: "load-cap-2",
      agentEndpointId: endpointId
    });
    await client.waitForDispatchStatus(second.operationId, ["leased", "running"]);
    expect(client.countServerRows("remote_operations")).toBe(2);
    expect(client.countServerRows("remote_execution_attempts")).toBe(2);
    expect(client.countServerRows("host_capacity_reservations")).toBe(2);
    expect(client.countExecuteBlockMailboxMessages([first.dispatchId, second.dispatchId])).toBe(2);

    await harness.acpControl.resume();
    const [term1, term2] = await Promise.all([
      client.waitForTerminal(first.operationId),
      client.waitForTerminal(second.operationId)
    ]);
    expect(term1.state).toBe("completed");
    expect(term2.state).toBe("completed");
    expect(second.operationId).not.toBe(first.operationId);

    expect(
      client.countServerRows("remote_execution_attempts", "operation_id IN (?,?)", [
        first.operationId,
        second.operationId
      ])
    ).toBe(2);
    expect(
      client.countServerRows("dispatches", "id IN (?,?) AND status='completed'", [
        first.dispatchId,
        term2.dispatchId
      ])
    ).toBe(2);
  }, 180_000);

  it("cancel at barrier + short lease still fail-closed (no false complete, no extra attempt)", async () => {
    const { harness, client } = await createHarness({
      hostCapacity: 1,
      serverLimits: {
        leaseDurationMs: 5_000,
        hostOfflineAfterMs: 20_000,
        heartbeatIntervalMs: 1_000
      }
    });
    await harness.startAll();
    await harness.acpControl.pause(["session/prompt"]);

    const dispatched = await client.dispatch({
      blockRef: "T-001#B-001",
      idempotencyKey: "load-cancel-lease-1"
    });
    await client.waitForDispatchStatus(dispatched.operationId, ["leased", "running"]);
    await harness.acpControl.waitUntilLifecycleContains("paused session/prompt", 30_000);

    const sessionNewBefore = client.countLifecycleFragment("session/new");
    expect(sessionNewBefore).toBe(LOAD_RECOVERY_THRESHOLDS.maxSessionNewPerAttempt);

    await client.cancel(dispatched.operationId, "load recovery cancel");
    await harness.acpControl.resume();

    const terminal = await client.waitForTerminal(dispatched.operationId);
    expect(terminal.state).toBe("cancelled");
    expect(terminal.state).not.toBe("completed");
    expect(client.countLifecycleFragment("session/new")).toBe(sessionNewBefore);
    expect(
      client.countServerRows("remote_execution_attempts", "operation_id=?", [
        dispatched.operationId
      ])
    ).toBe(1);
  }, 120_000);
});
