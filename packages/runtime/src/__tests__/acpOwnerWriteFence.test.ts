import { appendFile, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AcpEventStore } from "../autoRun/acpEventStore.js";
import { AcpOwnerStateWriter } from "../autoRun/acpOwnerState.js";
import { AcpOwnerWriteFence } from "../autoRun/acpOwnerWriteFence.js";
import { unavailableAgentRunControlSummary } from "../autoRun/agentRunControlAvailability.js";
import { normalizedOutputBody } from "../autoRun/normalizedEventContract.js";
import { writeJsonFile } from "../json.js";

const leaseId = "00000000-0000-4000-8000-000000000001";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function eventStore(runDir: string, fence: AcpOwnerWriteFence, appendText = appendFile) {
  return new AcpEventStore({
    runDir,
    identity: {
      projectId: "project-1",
      canvasId: "default",
      taskId: "T-001",
      blockId: "B-001",
      claimRef: "T-001#B-001",
      runId: "RUN-001",
      runOwner: "executor",
      runSessionId: null,
      desktopRunId: null,
      executorRunId: "RUN-001"
    },
    runner: { version: "planweave.runner/v1", runnerKind: "acp", agentId: "codex" },
    appendText,
    writeGuard: (operation) => fence.withOwnerWrite(operation)
  });
}

function writeEvent(store: AcpEventStore, kind: "protocol" | "ordinary" | "terminal") {
  if (kind === "protocol") {
    return store.appendProtocol("agent_to_client", { method: "session/update" });
  }
  if (kind === "ordinary") {
    return store.append(normalizedOutputBody("stdout", "ordinary"));
  }
  return store.append({
    kind: "terminal",
    outcome: {
      version: "planweave.runner/v1",
      state: "failed",
      reason: "failed",
      exitCode: 1,
      finishedAt: "2026-07-17T00:01:00.000Z",
      diagnostic: "owner lost",
      artifactValidated: false
    }
  });
}

describe("ACP durable owner write fence", () => {
  it("holds the reconciliation lock for actual metadata and heartbeat writes", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-owner-state-fence-"));
    const fence = new AcpOwnerWriteFence(runDir, leaseId, 1);
    const writeStarted = deferred();
    const releaseWrite = deferred();
    let writes = 0;
    const writer = new AcpOwnerStateWriter({
      heartbeatPath: join(runDir, "heartbeat.json"),
      metadataPath: join(runDir, "metadata.json"),
      ownerLeaseId: leaseId,
      ownerGeneration: 1,
      startedAt: "2026-07-17T00:00:00.000Z",
      controlAvailability: unavailableAgentRunControlSummary("initializing"),
      metadata: { runId: "RUN-001" },
      writeGuard: (operation) => fence.withOwnerWrite(operation),
      write: async (path, value) => {
        writes += 1;
        if (writes === 1) {
          writeStarted.resolve();
          await releaseWrite.promise;
        }
        await writeJsonFile(path, value);
      }
    });

    const ownerWrite = writer.update("running", { sessionId: "session-1" });
    await writeStarted.promise;
    let claimFinished = false;
    const claim = fence
      .claimAfter(async () => true, "2026-07-17T00:01:00.000Z")
      .then((result) => {
        claimFinished = true;
        return result;
      });
    await new Promise((resolve) => setImmediate(resolve));
    expect(claimFinished).toBe(false);
    releaseWrite.resolve();
    await expect(ownerWrite).resolves.toBeUndefined();
    await expect(claim).resolves.toBe(true);
    await expect(writer.heartbeat()).rejects.toThrow("fenced by canonical orphan reconciliation");
  });

  it.each([
    "protocol",
    "ordinary",
    "terminal"
  ] as const)("makes reconciliation wait for an in-flight actual %s write", async (kind) => {
    const runDir = await mkdtemp(join(tmpdir(), `planweave-event-inflight-${kind}-`));
    const fence = new AcpOwnerWriteFence(runDir, leaseId, 1);
    const writeStarted = deferred();
    const releaseWrite = deferred();
    const store = eventStore(runDir, fence, async (...args) => {
      writeStarted.resolve();
      await releaseWrite.promise;
      return appendFile(...args);
    });
    await store.open();
    const write = writeEvent(store, kind);
    await writeStarted.promise;
    let claimFinished = false;
    const claim = fence
      .claimAfter(async () => true, "2026-07-17T00:01:00.000Z")
      .then((result) => {
        claimFinished = true;
        return result;
      });
    await new Promise((resolve) => setImmediate(resolve));
    expect(claimFinished).toBe(false);
    releaseWrite.resolve();
    await expect(write).resolves.toBeUndefined();
    await expect(claim).resolves.toBe(true);
  });

  it.each([
    "protocol",
    "ordinary",
    "terminal"
  ] as const)("rejects an actual %s event write when the reconciliation claim wins", async (kind) => {
    const runDir = await mkdtemp(join(tmpdir(), `planweave-event-fence-${kind}-`));
    const fence = new AcpOwnerWriteFence(runDir, leaseId, 1);
    await fence.claimAfter(async () => true, "2026-07-17T00:01:00.000Z");
    const store = eventStore(runDir, fence);
    await store.open();
    const write = writeEvent(store, kind);
    await expect(write).rejects.toThrow("fenced by canonical orphan reconciliation");
  });

  it("serializes sequence allocation under the lock and rejects all events after terminal", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-event-terminal-fence-"));
    const fence = new AcpOwnerWriteFence(runDir, leaseId, 1);
    const store = eventStore(runDir, fence);
    await store.open();
    await store.append({
      kind: "terminal",
      outcome: {
        version: "planweave.runner/v1",
        state: "failed",
        reason: "failed",
        exitCode: 1,
        finishedAt: "2026-07-17T00:01:00.000Z",
        diagnostic: "failed",
        artifactValidated: false
      }
    });
    await expect(
      store.append({ kind: "output", stream: "stdout", text: "too late" })
    ).rejects.toThrow("terminal and rejects further events");
    await expect(store.appendProtocol("agent_to_client", { late: true })).rejects.toThrow(
      "terminal and rejects further protocol events"
    );
    const events = (await readFile(join(runDir, "events.ndjson"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { sequence: number });
    expect(events.map((event) => event.sequence)).toEqual([1]);
  });
});
