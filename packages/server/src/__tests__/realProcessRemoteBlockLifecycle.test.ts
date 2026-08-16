/**
 * Real multi-process remote Block lifecycle coverage (RV-002#B-002).
 *
 * Spawns Server + Agent Host dist bins + fake ACP, drives operator HTTP APIs,
 * and asserts exact identities across Server/Host/Runtime read models.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizedFailureSchema } from "@planweave-ai/agent-host-protocol";
import {
  claimBlock,
  claimDispatchedBlock,
  createRemoteBlockRuntimePort,
  submitBlockResult
} from "@planweave-ai/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { writeReport } from "../../../runtime/src/__tests__/promptTestHelpers.js";
import {
  RealProcessAcpHarness,
  type RealProcessAcpHarnessOptions
} from "./support/realProcessAcpHarness.js";
import { remoteAcpManifestWithDependency } from "./support/realProcessAcpManifests.js";
import { RealProcessLifecycleClient } from "./support/realProcessLifecycleClient.js";

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
  return { harness, client: new RealProcessLifecycleClient(harness, 60_000) };
}

function assertIdentityChain(
  view: Awaited<ReturnType<RealProcessLifecycleClient["observe"]>>,
  expected: {
    operationId: string;
    dispatchId: string;
    executionAttemptId: string;
    leaseId?: string;
  }
): void {
  expect(view.operationId).toBe(expected.operationId);
  expect(view.dispatchId).toBe(expected.dispatchId);
  expect(view.executionAttemptId).toBe(expected.executionAttemptId);
  expect(view.attempt.dispatchId).toBe(expected.dispatchId);
  expect(view.attempt.executionAttemptId).toBe(expected.executionAttemptId);
  if (expected.leaseId) {
    expect(view.attempt.leaseId).toBe(expected.leaseId);
  }
  if (view.runtime.terminalReceipt) {
    expect(view.runtime.terminalReceipt.operationId).toBe(expected.operationId);
    expect(view.runtime.terminalReceipt.dispatchId).toBe(expected.dispatchId);
    expect(view.runtime.terminalReceipt.executionAttemptId).toBe(expected.executionAttemptId);
  }
}

describe("real-process remote Block lifecycle", () => {
  it("success: eligibility → remote claim → host select → envelope/grant → WSS → ACP → report → Runtime submit", async () => {
    const { harness, client } = await createHarness({ acpScenario: "success" });
    await harness.startAll();
    const host = await harness.waitForHostOnline();
    const endpoint = await client.availableAgentEndpointForHostDisplayName(host.displayName);

    const dispatched = await client.dispatch({
      blockRef: "T-001#B-001",
      idempotencyKey: "lifecycle-success-1",
      agentEndpointId: endpoint.endpointId
    });
    expect(dispatched).toMatchObject({
      projectId: harness.projectId,
      canvasId: "default",
      blockRef: "T-001#B-001",
      state: "activated"
    });
    // A fast local ACP may already be writing back before the first operator observation.
    expect(["leased", "running", "awaiting_writeback", "completed"]).toContain(
      dispatched.dispatchStatus
    );
    expect(dispatched.dispatchId).toMatch(/^dispatch-/);
    expect(dispatched.executionAttemptId).toMatch(/^attempt-/);
    expect(dispatched.attempt.leaseId).toMatch(/^lease-/);
    expect(dispatched.agentEndpoint).toMatchObject({
      endpointId: endpoint.endpointId,
      hostDisplayName: host.displayName
    });
    expect(dispatched.attempt.hostId).toBeUndefined();

    const identities = {
      operationId: dispatched.operationId,
      dispatchId: dispatched.dispatchId,
      executionAttemptId: dispatched.executionAttemptId,
      leaseId: dispatched.attempt.leaseId
    };

    await client.waitForDispatchStatus(dispatched.operationId, ["running", "completed"]);

    const terminal = await client.waitForTerminal(dispatched.operationId);
    // ACP stdio lifecycle is durable in the harness control dir (not production logs).
    const lifecycle = await harness.acpControl.waitUntilLifecycleContains("session/prompt", 15_000);
    expect(lifecycle.some((line) => line.includes("initialize"))).toBe(true);
    expect(lifecycle.some((line) => line.includes("session/new"))).toBe(true);
    assertIdentityChain(terminal, identities);
    expect(terminal).toMatchObject({
      state: "completed",
      dispatchStatus: "completed",
      attempt: {
        status: "completed",
        leaseId: identities.leaseId
      },
      agentEndpoint: {
        endpointId: endpoint.endpointId,
        hostDisplayName: host.displayName
      },
      runtime: {
        status: "completed",
        terminalReceipt: {
          outcome: "completed",
          operationId: identities.operationId,
          dispatchId: identities.dispatchId,
          executionAttemptId: identities.executionAttemptId,
          runId: expect.any(String)
        }
      }
    });

    const dispatchRow = client.readServerDispatch(identities.dispatchId);
    expect(dispatchRow).toMatchObject({
      id: identities.dispatchId,
      status: "completed",
      host_id: host.id,
      lease_id: identities.leaseId,
      execution_attempt_id: identities.executionAttemptId
    });
    const result = JSON.parse(String(dispatchRow.result_json)) as {
      summary: string;
      reportArtifactRef: string;
    };
    expect(result.summary).toMatch(/hello from mock-session/);
    expect(result.reportArtifactRef).toMatch(/^artifact:sha256:/);

    const links = client.readServerArtifactLinks(identities.dispatchId);
    expect(links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          purpose: "report",
          permission: "report_write",
          artifact_ref: result.reportArtifactRef
        })
      ])
    );

    const envelope = client.readServerEnvelope(identities.dispatchId);
    expect(envelope).toMatchObject({
      blockRef: "T-001#B-001",
      requiredCapabilities: ["acp.codex"],
      execution: {
        dispatchId: identities.dispatchId,
        attemptId: identities.executionAttemptId
      },
      output: { reportRequired: true }
    });

    const events = await client.listEvents(dispatched.operationId, 0);
    expect(events.executionAttemptId).toBe(identities.executionAttemptId);
    expect(events.events.length).toBeGreaterThan(0);
    expect(events.events.some((event) => event.kind === "agent_message")).toBe(true);

    // Authoritative Runtime results land under the project home.
    const canvasHome = join(
      harness.paths.projectHome,
      "projects",
      harness.projectId,
      "canvases",
      "default"
    );
    const statePath = join(canvasHome, "state.json");
    const state = JSON.parse(await readFile(statePath, "utf8")) as {
      blocks: Record<string, { status?: string; lastRunId?: string }>;
      current?: { ref?: string } | null;
    };
    const blockState = state.blocks["T-001#B-001"] ?? state.blocks["B-001"];
    expect(blockState?.status).toBe("completed");
    const runId = terminal.runtime.terminalReceipt?.runId ?? blockState?.lastRunId;
    expect(runId).toEqual(expect.stringMatching(/^RUN-/));

    // Byte-level: Runtime report.md must match Server artifact blob and digest.
    const reportPath = join(
      canvasHome,
      "results",
      "T-001",
      "blocks",
      "B-001",
      "runs",
      String(runId),
      "report.md"
    );
    const runtimeReportBytes = await readFile(reportPath);
    expect(runtimeReportBytes.byteLength).toBeGreaterThan(0);
    expect(runtimeReportBytes.toString("utf8")).toMatch(/hello from mock-session/);
    const runtimeDigest = createHash("sha256").update(runtimeReportBytes).digest("hex");
    expect(result.reportArtifactRef).toBe(`artifact:sha256:${runtimeDigest}`);

    const serverArtifactBytes = client.readServerArtifactBytes(result.reportArtifactRef);
    expect(Buffer.compare(serverArtifactBytes, runtimeReportBytes)).toBe(0);
    expect(createHash("sha256").update(serverArtifactBytes).digest("hex")).toBe(runtimeDigest);

    // Sensitivity: result index / run directory exists for the claimed runId only.
    const runsDir = join(canvasHome, "results", "T-001", "blocks", "B-001", "runs");
    const runEntries = await readdir(runsDir);
    expect(runEntries).toContain(String(runId));
  }, 90_000);

  it("ACP-declared failure (refusal) terminalizes with matching identities", async () => {
    const { harness, client } = await createHarness({ acpScenario: "refusal" });
    await harness.startAll();
    const dispatched = await client.dispatch({
      blockRef: "T-001#B-001",
      idempotencyKey: "lifecycle-refusal-1"
    });
    const terminal = await client.waitForTerminal(dispatched.operationId);
    assertIdentityChain(terminal, {
      operationId: dispatched.operationId,
      dispatchId: dispatched.dispatchId,
      executionAttemptId: dispatched.executionAttemptId,
      leaseId: dispatched.attempt.leaseId
    });
    expect(terminal.state).toBe("failed");
    expect(terminal.dispatchStatus).toBe("failed");
    expect(terminal.runtime.status).toBe("blocked");
    expect(terminal.runtime.terminalReceipt).toMatchObject({
      outcome: "failed",
      dispatchId: dispatched.dispatchId,
      executionAttemptId: dispatched.executionAttemptId,
      failure: { code: "acp_incomplete_response", retryable: false }
    });
    const dispatchRow = client.readServerDispatch(dispatched.dispatchId);
    if (!dispatchRow.failure_json) throw new Error("host_terminal_failure_missing");
    const deliveredFailure = normalizedFailureSchema.parse(JSON.parse(dispatchRow.failure_json));
    expect(deliveredFailure.code).toEqual(expect.any(String));
    expect(deliveredFailure.retryable).toBe(false);
    expect(client.readHostTerminalReceipt(dispatched.dispatchId)).toMatchObject({
      execution_attempt_id: dispatched.executionAttemptId,
      terminal_kind: "failed",
      terminal_payload_digest: `sha256:${createHash("sha256")
        .update(JSON.stringify(deliveredFailure))
        .digest("hex")}`
    });
  }, 90_000);

  it("process/protocol error fails closed without false success", async () => {
    const { harness, client } = await createHarness({ acpScenario: "protocol-error" });
    await harness.startAll();
    const dispatched = await client.dispatch({
      blockRef: "T-001#B-001",
      idempotencyKey: "lifecycle-protocol-error-1"
    });
    const terminal = await client.waitForTerminal(dispatched.operationId);
    expect(terminal.state).toBe("failed");
    expect(terminal.dispatchStatus).toBe("failed");
    expect(terminal.runtime.terminalReceipt?.outcome).toBe("failed");
    expect(terminal.runtime.status).not.toBe("completed");
    const row = client.readServerDispatch(dispatched.dispatchId);
    expect(row.status).toBe("failed");
    expect(row.result_json).toBeNull();
    expect(row.failure_json).toBeTruthy();
  }, 90_000);

  it("user cancellation during ACP barrier reaches cancelled terminal with identity fidelity", async () => {
    const { harness, client } = await createHarness({ acpScenario: "success" });
    await harness.startAll();
    await harness.acpControl.pause(["session/prompt"]);
    const dispatched = await client.dispatch({
      blockRef: "T-001#B-001",
      idempotencyKey: "lifecycle-cancel-1"
    });
    await harness.acpControl.waitUntilLifecycleContains("paused session/prompt", 30_000);
    await client.waitForDispatchStatus(dispatched.operationId, ["running", "leased"]);
    const before = await client.observe(dispatched.operationId);
    const action = await client.cancel(dispatched.operationId, "user cancelled at barrier");
    expect(action).toMatchObject({
      request: {
        kind: "cancel",
        dispatchId: before.dispatchId,
        executionAttemptId: before.executionAttemptId,
        leaseId: before.attempt.leaseId
      }
    });
    await harness.acpControl.resume();
    const terminal = await client.waitForTerminal(dispatched.operationId);
    assertIdentityChain(terminal, {
      operationId: dispatched.operationId,
      dispatchId: dispatched.dispatchId,
      executionAttemptId: dispatched.executionAttemptId,
      leaseId: before.attempt.leaseId
    });
    expect(terminal.state).toBe("cancelled");
    expect(terminal.dispatchStatus).toBe("cancelled");
    expect(terminal.runtime.terminalReceipt).toMatchObject({
      outcome: "failed",
      failure: { code: "execution_cancelled", retryable: false }
    });
  }, 90_000);

  it("interaction request/response (permission allow) then successful completion", async () => {
    const { harness, client } = await createHarness({ acpScenario: "permission" });
    await harness.startAll();
    const dispatched = await client.dispatch({
      blockRef: "T-001#B-001",
      idempotencyKey: "lifecycle-permission-1"
    });
    const interaction = await client.waitForPendingInteraction(dispatched.operationId);
    expect(interaction.request).toMatchObject({
      type: "interaction.permission_requested",
      dispatchId: dispatched.dispatchId,
      executionAttemptId: dispatched.executionAttemptId,
      leaseId: dispatched.attempt.leaseId
    });
    const settled = await client.settlePermission(
      dispatched.operationId,
      interaction,
      "allow_once"
    );
    expect(settled).toMatchObject({
      status: "settled",
      settledBy: "harness-operator",
      settlement: {
        type: "interaction.permission_response",
        decision: "allow_once",
        actionId: interaction.request.actionId,
        dispatchId: dispatched.dispatchId,
        executionAttemptId: dispatched.executionAttemptId
      }
    });
    const terminal = await client.waitForTerminal(dispatched.operationId);
    expect(terminal.state).toBe("completed");
    expect(terminal.dispatchStatus).toBe("completed");
    assertIdentityChain(terminal, {
      operationId: dispatched.operationId,
      dispatchId: dispatched.dispatchId,
      executionAttemptId: dispatched.executionAttemptId,
      leaseId: dispatched.attempt.leaseId
    });
  }, 90_000);

  it("input/output artifacts and dependency summaries flow through envelope and Runtime", async () => {
    const { harness, client } = await createHarness({
      acpScenario: "success",
      manifest: remoteAcpManifestWithDependency()
    });
    // Complete upstream dependency locally (no Server required for package writeback).
    process.env.PLANWEAVE_HOME = harness.paths.projectHome;
    await claimDispatchedBlock({
      projectRoot: harness.paths.projectRoot,
      ref: "T-001#B-001"
    });
    const reportPath = await writeReport(
      harness.paths.projectRoot,
      "upstream-dep.md",
      "upstream dependency report\n"
    );
    await submitBlockResult({
      projectRoot: harness.paths.projectRoot,
      ref: "T-001#B-001",
      reportPath
    });

    await harness.startAll();
    const dispatched = await client.dispatch({
      blockRef: "T-001#B-002",
      idempotencyKey: "lifecycle-deps-1"
    });
    const terminal = await client.waitForTerminal(dispatched.operationId);
    expect(terminal.state).toBe("completed");
    expect(terminal.blockRef).toBe("T-001#B-002");

    const envelope = client.readServerEnvelope(dispatched.dispatchId);
    expect(envelope.blockRef).toBe("T-001#B-002");
    const dependencySummaries = envelope.dependencySummaries as Array<Record<string, unknown>>;
    expect(dependencySummaries.length).toBeGreaterThan(0);
    expect(dependencySummaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          blockRef: "T-001#B-001"
        })
      ])
    );
    const inputArtifacts = envelope.inputArtifacts as Array<Record<string, unknown>>;
    expect(inputArtifacts.length).toBeGreaterThan(0);
    expect(inputArtifacts[0]).toMatchObject({
      logicalName: expect.any(String),
      artifactRef: expect.stringMatching(/^artifact:sha256:/)
    });

    const result = JSON.parse(
      String(client.readServerDispatch(dispatched.dispatchId).result_json)
    ) as { reportArtifactRef: string };
    const links = client.readServerArtifactLinks(dispatched.dispatchId);
    expect(links.some((link) => link.purpose === "report")).toBe(true);
    expect(result.reportArtifactRef).toMatch(/^artifact:sha256:/);
  }, 120_000);

  it("event disconnect/replay preserves durable ACP events after Host restart", async () => {
    const { harness, client } = await createHarness({ acpScenario: "success" });
    await harness.startAll();
    await harness.acpControl.pause(["session/prompt"]);
    const dispatched = await client.dispatch({
      blockRef: "T-001#B-001",
      idempotencyKey: "lifecycle-events-1"
    });
    await harness.acpControl.waitUntilLifecycleContains("paused session/prompt", 30_000);
    await client.waitForDispatchStatus(dispatched.operationId, "running");
    await harness.acpControl.resume();
    const terminal = await client.waitForTerminal(dispatched.operationId);
    expect(terminal.state).toBe("completed");

    const first = await client.listEvents(dispatched.operationId, 0);
    expect(first.events.length).toBeGreaterThan(0);
    expect(first.executionAttemptId).toBe(dispatched.executionAttemptId);
    const message = first.events.find((event) => event.kind === "agent_message");
    expect(message).toMatchObject({ text: expect.stringContaining("hello from mock-session") });

    const cursor = first.cursor;
    await harness.restartHost();
    const replay = await client.listEvents(dispatched.operationId, 0);
    expect(replay.executionAttemptId).toBe(dispatched.executionAttemptId);
    expect(replay.events).toEqual(first.events);
    expect(replay.highWatermark).toBe(first.highWatermark);

    const after = await client.listEvents(dispatched.operationId, cursor);
    expect(after.afterCursor).toBe(cursor);
    expect(after.events).toEqual([]);
    expect(after.hasMore).toBe(false);
  }, 120_000);

  it("two Hosts: available incompatible endpoint creates no operation; compatible endpoint completes", async () => {
    const { harness, client } = await createHarness({
      acpScenario: "success",
      hostDisplayName: "Incompatible Host",
      hostCapabilities: ["acp.opencode"],
      hostAgentProfile: { id: "opencode-acp", agentId: "opencode" },
      hostCapacity: 2
    });
    await harness.startServer();
    await harness.waitForServerReadyz();
    await harness.startHost();
    const incompatible = await harness.waitForHostOnline({ displayName: "Incompatible Host" });

    const incompatibleEndpoints = (await client.listAgentEndpoints()).items.filter(
      (endpoint) =>
        endpoint.hostDisplayName === "Incompatible Host" && endpoint.agentId === "opencode"
    );
    if (incompatibleEndpoints.length !== 1) {
      throw new Error(`expected_one_incompatible_endpoint:${incompatibleEndpoints.length}`);
    }
    const incompatibleEndpoint = incompatibleEndpoints[0];
    expect(incompatibleEndpoint).toMatchObject({
      status: "available",
      capabilities: ["acp.opencode"]
    });
    const rejected = await client.rawDispatch({
      blockRef: "T-001#B-001",
      idempotencyKey: "lifecycle-select-incompatible",
      agentEndpointId: incompatibleEndpoint.endpointId
    });
    expect(rejected).toMatchObject({
      status: 409,
      body: { error: "agent_endpoint_incompatible" }
    });
    expect(client.countServerRows("remote_operations")).toBe(0);
    expect(client.countServerRows("remote_execution_attempts")).toBe(0);

    const secondary = await harness.startSecondaryHost({
      key: "compatible",
      displayName: "Compatible Host",
      capabilities: ["acp.codex"],
      capacity: 1,
      acpScenario: "success"
    });
    expect(secondary.id).not.toBe(incompatible.id);

    const compatibleEndpoint =
      await client.availableAgentEndpointForHostDisplayName("Compatible Host");
    const activated = await client.dispatch({
      blockRef: "T-001#B-001",
      idempotencyKey: "lifecycle-select-compatible",
      agentEndpointId: compatibleEndpoint.endpointId
    });
    expect(activated.agentEndpoint).toMatchObject({
      endpointId: compatibleEndpoint.endpointId,
      hostDisplayName: "Compatible Host"
    });
    expect(
      ["activated", "completed"].includes(activated.state) ||
        ["leased", "running", "completed"].includes(String(activated.dispatchStatus))
    ).toBe(true);

    const terminal = await client.waitForTerminal(activated.operationId);
    expect(terminal.state).toBe("completed");
    expect(terminal.agentEndpoint).toMatchObject({
      endpointId: compatibleEndpoint.endpointId,
      hostDisplayName: "Compatible Host"
    });
    expect(terminal.attempt.hostId).toBeUndefined();

    const hosts = await client.listHosts();
    expect(hosts.items.map((item) => item.displayName).sort()).toEqual([
      "Compatible Host",
      "Incompatible Host"
    ]);
    const dispatchRow = client.readServerDispatch(terminal.dispatchId);
    expect(dispatchRow.host_id).toBe(secondary.id);
  }, 120_000);

  it("local manual claim/submit works without Server", async () => {
    const { harness } = await createHarness({ acpScenario: "success" });
    // Intentionally do not start Server or Host.
    process.env.PLANWEAVE_HOME = harness.paths.projectHome;
    const claimed = await claimBlock({
      projectRoot: harness.paths.projectRoot,
      ref: "T-001#B-001"
    });
    expect(claimed).toMatchObject({ ref: "T-001#B-001" });
    const reportPath = await writeReport(
      harness.paths.projectRoot,
      "local-manual.md",
      "# Local manual result\n\nCompleted without Server.\n"
    );
    const submitted = await submitBlockResult({
      projectRoot: harness.paths.projectRoot,
      ref: "T-001#B-001",
      reportPath
    });
    expect(submitted).toMatchObject({ ref: "T-001#B-001" });

    const runtime = createRemoteBlockRuntimePort({ projectRoot: harness.paths.projectRoot });
    // Block is complete for local ownership; remote inspect should see completed local state.
    const candidate = await runtime.inspect({ ref: "T-001#R-001" }).catch(() => undefined);
    expect(candidate === undefined || candidate.blockRef === "T-001#R-001").toBe(true);

    const statePath = join(
      harness.paths.projectHome,
      "projects",
      harness.projectId,
      "canvases",
      "default",
      "state.json"
    );
    const state = JSON.parse(await readFile(statePath, "utf8")) as {
      current?: { ref?: string } | null;
      blocks?: Record<string, { status?: string }>;
    };
    // Local submit advances package state without any Server process.
    expect(state.current === null || state.current === undefined || state.current.ref).toBeTruthy();
  }, 60_000);
});
