import {
  CANVAS_RUNTIME_CAPABILITY,
  agentHostProtocolVersion,
  type CanvasRuntimeRequestCommand
} from "@planweave-ai/agent-host-protocol";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CanvasRuntimeRpcBroker, CanvasRuntimeRpcError } from "../canvas/runtimeRpcBroker.js";
import { AgentHostRepository } from "../hosts.js";
import { DurableMailbox, type MailboxMessage } from "../mailbox.js";
import { applyMigrations } from "../migrations.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";

const databases: SqliteDatabase[] = [];
const scope = { workspaceId: "workspace-rpc", projectId: "project-rpc", canvasId: "default" };

afterEach(() => {
  vi.useRealTimers();
  for (const database of databases.splice(0)) database.close();
});

async function setup(timeout = 1_000) {
  const database = await openServerDatabase(":memory:", 5_000);
  databases.push(database);
  applyMigrations(database);
  const hosts = new AgentHostRepository(database);
  const mailbox = new DurableMailbox(database);
  const host = hosts.register("Runtime Host").host;
  hosts.reportOnline(host.id, [CANVAS_RUNTIME_CAPABILITY], 1);
  const active = new Set([host.id]);
  const broker = new CanvasRuntimeRpcBroker(database, hosts, mailbox, {
    requestTimeoutMs: timeout,
    clock: () => new Date("2026-08-20T00:00:00.000Z")
  });
  broker.attachSessionLookup({ isActive: (hostId) => active.has(hostId) });
  const deliveries: MailboxMessage[] = [];
  mailbox.subscribe(host.id, (message) => deliveries.push(message));
  return { active, broker, database, deliveries, host, hosts, mailbox };
}

function requestCommand(message: MailboxMessage): CanvasRuntimeRequestCommand {
  if (message.command.type !== "canvas_runtime.request") {
    throw new Error("test_canvas_runtime_request_expected");
  }
  return message.command;
}

function availabilityResponse(
  command: CanvasRuntimeRequestCommand,
  reason: "runtime_not_attached" | "host_offline"
) {
  return {
    type: "canvas_runtime.response" as const,
    protocolVersion: agentHostProtocolVersion,
    messageId: randomUUID(),
    requestId: command.requestId,
    response: {
      outcome: "success" as const,
      operation: "availability" as const,
      result: { kind: "unavailable" as const, reason }
    }
  };
}

describe("CanvasRuntimeRpcBroker", () => {
  it("correlates responses while mailbox ACK alone does not complete a request", async () => {
    const fixture = await setup();
    const first = fixture.broker.request(fixture.host.id, scope, { operation: "availability" });
    const second = fixture.broker.request(fixture.host.id, scope, { operation: "availability" });
    expect(fixture.broker.pendingCount()).toBe(2);

    const firstCommand = requestCommand(fixture.deliveries[0]!);
    const secondCommand = requestCommand(fixture.deliveries[1]!);
    fixture.broker.handleResponse(
      fixture.host.id,
      availabilityResponse(secondCommand, "host_offline")
    );
    fixture.broker.handleResponse(
      fixture.host.id,
      availabilityResponse(firstCommand, "runtime_not_attached")
    );

    await expect(first).resolves.toMatchObject({
      operation: "availability",
      result: { reason: "runtime_not_attached" }
    });
    await expect(second).resolves.toMatchObject({
      operation: "availability",
      result: { reason: "host_offline" }
    });
    expect(fixture.broker.pendingCount()).toBe(0);
  });

  it("persists and ignores orphan/duplicate durable responses after restart", async () => {
    const fixture = await setup();
    const orphan = availabilityResponse(
      {
        type: "canvas_runtime.request",
        protocolVersion: agentHostProtocolVersion,
        requestId: randomUUID(),
        scope,
        deadline: "2026-08-20T00:01:00.000Z",
        operation: { operation: "availability" }
      },
      "runtime_not_attached"
    );

    expect(fixture.broker.handleResponse(fixture.host.id, orphan)).toBe(true);
    expect(fixture.broker.handleResponse(fixture.host.id, orphan)).toBe(false);
    expect(fixture.broker.pendingCount()).toBe(0);
  });

  it("cleans deadline state and marks unknown mutation outcome for reconciliation", async () => {
    vi.useFakeTimers();
    const fixture = await setup(50);
    const deadline = fixture.broker.request(fixture.host.id, scope, { operation: "availability" });
    const deadlineAssertion = expect(deadline).rejects.toMatchObject({
      code: "canvas_runtime_rpc_deadline_exceeded",
      reconcileRequired: false
    });
    await vi.advanceTimersByTimeAsync(50);
    await deadlineAssertion;
    expect(fixture.broker.pendingCount()).toBe(0);

    const operationId = randomUUID();
    const sourceRevision = `snapshot:${"a".repeat(64)}`;
    const graphFingerprint = `pkg-${"b".repeat(64)}`;
    const mutation = fixture.broker.request(fixture.host.id, scope, {
      operation: "claim",
      runtimeLeaseId: randomUUID(),
      evidence: { operationId, sourceRevision, graphFingerprint },
      input: { operationId, sourceRevision, graphFingerprint }
    });
    fixture.broker.detachHost(fixture.host.id, "superseded");
    await expect(mutation).rejects.toMatchObject({
      code: "canvas_runtime_reconcile_required",
      reconcileRequired: true
    });
  });

  it.each([
    ["disconnected", "canvas_runtime_host_disconnected"],
    ["superseded", "canvas_runtime_host_superseded"],
    ["revoked", "canvas_runtime_host_revoked"]
  ] as const)("rejects pending work when a Host is %s", async (reason, code) => {
    const fixture = await setup();
    const pending = fixture.broker.request(fixture.host.id, scope, { operation: "availability" });

    fixture.broker.detachHost(fixture.host.id, reason);

    await expect(pending).rejects.toMatchObject({ code, reconcileRequired: false });
    expect(fixture.broker.pendingCount()).toBe(0);
  });

  it("invalidates an acquired attachment generation after detach", async () => {
    const fixture = await setup();
    const attachmentVersion = fixture.broker.attachmentVersion(fixture.host.id);
    fixture.broker.detachHost(fixture.host.id, "disconnected");

    await expect(
      fixture.broker.request(
        fixture.host.id,
        scope,
        { operation: "availability" },
        attachmentVersion
      )
    ).rejects.toMatchObject({ code: "canvas_runtime_host_offline" });
    expect(fixture.deliveries).toHaveLength(0);
  });

  it("fails closed and clears pending state for a response from the wrong Host", async () => {
    const fixture = await setup();
    const other = fixture.hosts.register("Other Runtime Host").host;
    fixture.hosts.reportOnline(other.id, [CANVAS_RUNTIME_CAPABILITY], 1);
    fixture.active.add(other.id);
    const pending = fixture.broker.request(fixture.host.id, scope, { operation: "availability" });
    const response = availabilityResponse(
      requestCommand(fixture.deliveries[0]!),
      "runtime_not_attached"
    );

    expect(fixture.broker.handleResponse(other.id, response)).toBe(true);
    await expect(pending).rejects.toEqual(
      new CanvasRuntimeRpcError("canvas_runtime_response_host_mismatch", false, false)
    );
    expect(fixture.broker.pendingCount()).toBe(0);
  });

  it("fails closed and clears pending state for a mismatched response operation", async () => {
    const fixture = await setup();
    const pending = fixture.broker.request(fixture.host.id, scope, { operation: "acquire" });
    const command = requestCommand(fixture.deliveries[0]!);

    expect(
      fixture.broker.handleResponse(
        fixture.host.id,
        availabilityResponse(command, "runtime_not_attached")
      )
    ).toBe(true);
    await expect(pending).rejects.toEqual(
      new CanvasRuntimeRpcError("canvas_runtime_response_operation_mismatch", false, false)
    );
    expect(fixture.broker.pendingCount()).toBe(0);
  });
});
