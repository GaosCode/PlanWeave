import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { activeAgentRunRegistry } from "../autoRun/activeAgentRunRegistry.js";
import { readRunnerRecordReadModel } from "../autoRun/runnerRecordReadModel.js";
import { PersistentRunnerInteractionStore } from "../autoRun/runnerInteractionStore.js";
import { writeJsonFile } from "../json.js";
import {
  activeHandle,
  createMailbox,
  event,
  mailboxMetadata,
  ownerLeaseId
} from "./helpers/runnerRecordReadModelFixture.js";

describe("runner record mailbox interaction projection", () => {
  it("projects a mailbox permission without desktopRunId or a live registry owner", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-acp-mailbox-record-"));
    await writeFile(
      join(runDir, "events.ndjson"),
      `${JSON.stringify(
        event(1, "interaction", "T-001#B-001", {
          desktopRunId: null,
          runSessionId: "SESSION-001"
        })
      )}\n`
    );
    await createMailbox(runDir, "2026-07-11T00:00:10.000Z");
    const result = await readRunnerRecordReadModel({
      runDir,
      metadata: { ...mailboxMetadata, desktopRunId: null },
      now: () => new Date("2026-07-11T00:00:11.000Z")
    });
    expect(result?.interaction).toMatchObject({
      active: true,
      stale: false,
      activeRequests: [
        {
          kind: "permission",
          identity: { ownerLeaseId },
          availability: { available: true, reason: null }
        }
      ]
    });
    expect(result?.intervention.cancel.available).toBe(false);
  });

  it("reprojects a stale same-lease mailbox as actionable after heartbeat recovery", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-acp-mailbox-stale-"));
    await writeFile(join(runDir, "events.ndjson"), `${JSON.stringify(event(1, "interaction"))}\n`);
    await createMailbox(runDir, "2026-07-11T00:00:00.000Z");
    const options = {
      runDir,
      metadata: mailboxMetadata,
      now: () => new Date("2026-07-11T00:01:00.000Z")
    };
    const stale = await readRunnerRecordReadModel(options);
    expect(stale?.interaction.activeRequests[0]?.availability).toEqual({
      available: false,
      reason: "owner_unavailable"
    });
    await writeJsonFile(join(runDir, "heartbeat.json"), {
      status: "running",
      pid: null,
      startedAt: "2026-07-11T00:00:00.000Z",
      lastHeartbeatAt: "2026-07-11T00:01:00.000Z",
      finishedAt: null,
      ownerLeaseId,
      ownerGeneration: 1,
      runnerLifecycle: "waiting_interaction",
      pendingInteractionIds: ["permission-1"]
    });
    const recovered = await readRunnerRecordReadModel(options);
    expect(recovered?.interaction.activeRequests[0]?.availability).toEqual({
      available: true,
      reason: null
    });
  });

  it("projects terminal metadata and replaced metadata ownership as closed reasons", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "planweave-acp-mailbox-metadata-"));
    await writeFile(join(runDir, "events.ndjson"), `${JSON.stringify(event(1, "interaction"))}\n`);
    await createMailbox(runDir, "2026-07-11T00:00:10.000Z");
    const baseMetadata = mailboxMetadata;
    const terminal = await readRunnerRecordReadModel({
      runDir,
      metadata: { ...baseMetadata, status: "completed" },
      now: () => new Date("2026-07-11T00:00:11.000Z")
    });
    expect(terminal?.interaction.activeRequests[0]?.availability).toEqual({
      available: false,
      reason: "run_terminal"
    });
    const replaced = await readRunnerRecordReadModel({
      runDir,
      metadata: {
        ...baseMetadata,
        ownerLeaseId: "22222222-2222-4222-8222-222222222222",
        ownerGeneration: 2
      },
      now: () => new Date("2026-07-11T00:00:11.000Z")
    });
    expect(replaced?.interaction.activeRequests[0]?.availability).toEqual({
      available: false,
      reason: "owner_replaced"
    });
  });

  it.each([
    "response",
    "owner_result"
  ] as const)("suppresses a lingering registry permission after the %s settlement", async (settlement) => {
    const runDir = await mkdtemp(join(tmpdir(), `planweave-acp-mailbox-${settlement}-`));
    await writeFile(join(runDir, "events.ndjson"), `${JSON.stringify(event(1, "interaction"))}\n`);
    await createMailbox(runDir, "2026-07-11T00:00:10.000Z");
    const store = new PersistentRunnerInteractionStore(runDir);
    const request = (await store.readSnapshot("permission-1")).request;
    if (settlement === "response") {
      await store.createResponse({
        version: "planweave.runner-interaction-response/v1",
        identity: request.identity,
        decision: { kind: "select", optionId: "allow" },
        respondedAt: "2026-07-11T00:00:11.000Z",
        decisionSource: "test-client",
        reason: null
      });
    } else {
      await store.createOwnerResult({
        version: "planweave.runner-interaction-owner-result/v1",
        identity: request.identity,
        outcome: "expired",
        reason: "deadline",
        recordedAt: "2026-07-11T00:00:11.000Z",
        message: "Permission request expired: deadline."
      });
    }
    const handle = activeHandle(runDir);
    activeAgentRunRegistry.register(handle);
    try {
      const result = await readRunnerRecordReadModel({
        runDir,
        metadata: mailboxMetadata,
        now: () => new Date("2026-07-11T00:00:11.000Z")
      });
      expect(result?.interaction.activeRequests).toEqual([]);
      expect(result?.interaction.active).toBe(false);
    } finally {
      await activeAgentRunRegistry.remove(handle, "test complete");
    }
  });

  it.each([
    ["heartbeat", "{broken"],
    ["heartbeat", "{}"],
    ["metadata", "{broken"],
    ["metadata", "{}"],
    ["mailbox", "{broken"],
    ["mailbox", "{}"]
  ] as const)("fails closed for invalid persisted %s JSON or schema", async (target, content) => {
    const runDir = await mkdtemp(join(tmpdir(), `planweave-acp-invalid-${target}-`));
    await writeFile(join(runDir, "events.ndjson"), `${JSON.stringify(event(1, "interaction"))}\n`);
    await createMailbox(runDir, "2026-07-11T00:00:10.000Z");
    const path =
      target === "mailbox"
        ? join(
            runDir,
            "interactions",
            Buffer.from("permission-1").toString("base64url"),
            "request.json"
          )
        : join(runDir, `${target}.json`);
    await writeFile(path, content, "utf8");
    const result = await readRunnerRecordReadModel({
      runDir,
      metadata: mailboxMetadata,
      now: () => new Date("2026-07-11T00:00:11.000Z")
    });
    expect(result?.interaction).toMatchObject({
      active: false,
      stale: true,
      activeRequests: [],
      diagnostic: {
        code: "contract_invalid",
        issues: expect.arrayContaining([expect.objectContaining({ source: target })])
      }
    });
  });
});
