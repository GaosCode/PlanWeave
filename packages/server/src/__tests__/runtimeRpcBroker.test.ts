import {
  CANVAS_RUNTIME_CAPABILITY,
  agentHostProtocolVersion,
  type CanvasRuntimeCancelCommand,
  type CanvasRuntimeRequestCommand
} from "@planweave-ai/agent-host-protocol";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CanvasRuntimeRpcBroker,
  CanvasRuntimeRpcError,
  type CanvasRuntimeRpcDiagnosticSink
} from "../canvas/runtimeRpcBroker.js";
import { AgentHostRepository } from "../hosts.js";
import { DurableMailbox, type MailboxMessage } from "../mailbox.js";
import { applyMigrations } from "../migrations.js";
import { openServerDatabase, type SqliteDatabase } from "../sqlite.js";

const databases: SqliteDatabase[] = [];
const scope = { workspaceId: "workspace-rpc", projectId: "project-rpc", canvasId: "default" };
const contentTarget = {
  revision: 1,
  content: {
    versionId: `version-${"c".repeat(64)}`,
    canonicalDigest: "c".repeat(64),
    verification: "complete" as const
  },
  graphFingerprint: `pkg-${"a".repeat(64)}`
};
const availabilityOperation = { operation: "availability" as const, contentTarget };

afterEach(() => {
  vi.useRealTimers();
  for (const database of databases.splice(0)) database.close();
});

async function setup(timeout = 1_000, diagnosticSink?: CanvasRuntimeRpcDiagnosticSink) {
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
    clock: () => new Date("2026-08-20T00:00:00.000Z"),
    ...(diagnosticSink ? { diagnosticSink } : {})
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

function cancelCommand(message: MailboxMessage): CanvasRuntimeCancelCommand {
  if (message.command.type !== "canvas_runtime.cancel") {
    throw new Error("test_canvas_runtime_cancel_expected");
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
    const first = fixture.broker.request(fixture.host.id, scope, availabilityOperation);
    const second = fixture.broker.request(fixture.host.id, scope, availabilityOperation);
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

  it("authorizes immutable content only while the exact Host RPC is pending", async () => {
    const fixture = await setup();
    const pending = fixture.broker.request(fixture.host.id, scope, availabilityOperation);

    expect(
      fixture.broker.authorizesContentTransfer(fixture.host.id, scope, contentTarget.content)
    ).toBe(true);
    expect(
      fixture.broker.authorizesContentTransfer(
        fixture.host.id,
        { ...scope, workspaceId: "workspace-other" },
        contentTarget.content
      )
    ).toBe(false);
    expect(
      fixture.broker.authorizesContentTransfer(fixture.host.id, scope, {
        ...contentTarget.content,
        canonicalDigest: "d".repeat(64)
      })
    ).toBe(false);

    const command = requestCommand(fixture.deliveries[0]!);
    fixture.broker.handleResponse(
      fixture.host.id,
      availabilityResponse(command, "runtime_not_attached")
    );
    await pending;
    expect(
      fixture.broker.authorizesContentTransfer(fixture.host.id, scope, contentTarget.content)
    ).toBe(false);
  });

  it("cancels a pending read before a response and safely ignores late responses", async () => {
    const fixture = await setup();
    const handle = fixture.broker.requestCancellableRead(
      fixture.host.id,
      scope,
      availabilityOperation
    );
    const cancelled = expect(handle.response).rejects.toEqual(
      new CanvasRuntimeRpcError("canvas_runtime_rpc_cancelled", false, false)
    );
    const request = requestCommand(fixture.deliveries[0]!);
    expect(
      fixture.broker.authorizesContentTransfer(fixture.host.id, scope, contentTarget.content)
    ).toBe(true);

    expect(handle.cancel()).toBe(true);

    await cancelled;
    expect(fixture.broker.pendingCount()).toBe(0);
    expect(
      fixture.broker.authorizesContentTransfer(fixture.host.id, scope, contentTarget.content)
    ).toBe(false);
    const cancellation = cancelCommand(fixture.deliveries[1]!);
    expect(fixture.deliveries[1]?.hostId).toBe(fixture.host.id);
    expect(cancellation).toMatchObject({
      targetRequestId: request.requestId,
      scope,
      deadline: "2026-08-20T00:00:01.000Z"
    });
    expect(cancellation.requestId).not.toBe(request.requestId);

    const late = availabilityResponse(request, "host_offline");
    expect(fixture.broker.handleResponse(fixture.host.id, late)).toBe(true);
    expect(fixture.broker.handleResponse(fixture.host.id, late)).toBe(false);
    expect(
      fixture.broker.handleResponse(fixture.host.id, {
        type: "canvas_runtime.response",
        protocolVersion: agentHostProtocolVersion,
        messageId: randomUUID(),
        requestId: cancellation.requestId,
        response: {
          outcome: "success",
          operation: "cancel",
          result: { targetRequestId: request.requestId, cancelled: true }
        }
      })
    ).toBe(true);
    expect(fixture.broker.pendingCount()).toBe(0);
  });

  it("does not cancel or enqueue a notification after the response wins", async () => {
    const fixture = await setup();
    const handle = fixture.broker.requestCancellableRead(
      fixture.host.id,
      scope,
      availabilityOperation
    );
    const command = requestCommand(fixture.deliveries[0]!);

    fixture.broker.handleResponse(
      fixture.host.id,
      availabilityResponse(command, "runtime_not_attached")
    );

    await expect(handle.response).resolves.toMatchObject({ operation: "availability" });
    expect(handle.cancel()).toBe(false);
    expect(fixture.deliveries).toHaveLength(1);
  });

  it("fences repeated cancellation to one local settlement and one Host notification", async () => {
    const fixture = await setup();
    const handle = fixture.broker.requestCancellableRead(
      fixture.host.id,
      scope,
      availabilityOperation
    );
    const cancelled = expect(handle.response).rejects.toMatchObject({
      code: "canvas_runtime_rpc_cancelled"
    });

    expect(handle.cancel()).toBe(true);
    expect(handle.cancel()).toBe(false);

    await cancelled;
    expect(fixture.deliveries.map(({ command }) => command.type)).toEqual([
      "canvas_runtime.request",
      "canvas_runtime.cancel"
    ]);
  });

  it("allows resolve_work_items cancellation but rejects other Runtime operations", async () => {
    const fixture = await setup();
    const handle = fixture.broker.requestCancellableRead(fixture.host.id, scope, {
      operation: "resolve_work_items",
      contentTarget,
      input: { workItems: [] }
    });
    const cancelled = expect(handle.response).rejects.toMatchObject({
      code: "canvas_runtime_rpc_cancelled"
    });

    expect(requestCommand(fixture.deliveries[0]!).operation.operation).toBe("resolve_work_items");
    expect(handle.cancel()).toBe(true);
    await cancelled;

    expect(() =>
      Reflect.apply(fixture.broker.requestCancellableRead, fixture.broker, [
        fixture.host.id,
        scope,
        { operation: "acquire", contentTarget }
      ])
    ).toThrow("canvas_runtime_rpc_cancellation_unsupported");
  });

  it("fences cancellation against Host detach in either order", async () => {
    const detached = await setup();
    const detachedHandle = detached.broker.requestCancellableRead(
      detached.host.id,
      scope,
      availabilityOperation
    );
    const disconnected = expect(detachedHandle.response).rejects.toMatchObject({
      code: "canvas_runtime_host_disconnected"
    });
    detached.broker.detachHost(detached.host.id, "disconnected");
    expect(detachedHandle.cancel()).toBe(false);
    await disconnected;
    expect(detached.deliveries).toHaveLength(1);

    const cancelled = await setup();
    const cancelledHandle = cancelled.broker.requestCancellableRead(
      cancelled.host.id,
      scope,
      availabilityOperation
    );
    const cancellation = expect(cancelledHandle.response).rejects.toMatchObject({
      code: "canvas_runtime_rpc_cancelled"
    });
    expect(cancelledHandle.cancel()).toBe(true);
    cancelled.broker.detachHost(cancelled.host.id, "disconnected");
    await cancellation;
    expect(cancelled.deliveries).toHaveLength(2);
    expect(cancelled.broker.pendingCount()).toBe(0);
  });

  it("keeps local cancellation authoritative when Host notification publish fails", async () => {
    const diagnosticSink = vi.fn<CanvasRuntimeRpcDiagnosticSink>();
    const fixture = await setup(1_000, diagnosticSink);
    fixture.mailbox.subscribe(fixture.host.id, (message) => {
      if (message.command.type === "canvas_runtime.cancel") {
        throw new Error("secret:/private/runtime/cancel");
      }
    });
    const handle = fixture.broker.requestCancellableRead(
      fixture.host.id,
      scope,
      availabilityOperation
    );
    const cancelled = expect(handle.response).rejects.toMatchObject({
      code: "canvas_runtime_rpc_cancelled"
    });

    expect(handle.cancel()).toBe(true);

    await cancelled;
    expect(fixture.broker.pendingCount()).toBe(0);
    expect(
      fixture.broker.authorizesContentTransfer(fixture.host.id, scope, contentTarget.content)
    ).toBe(false);
    expect(diagnosticSink).toHaveBeenCalledWith({
      hostId: fixture.host.id,
      operation: "availability",
      category: "cancel_publish_failed",
      code: "canvas_runtime_cancel_publish_failed"
    });
    expect(JSON.stringify(diagnosticSink.mock.calls)).not.toContain("secret");
    expect(JSON.stringify(diagnosticSink.mock.calls)).not.toContain("/private/runtime");
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
        operation: availabilityOperation
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
    const deadline = fixture.broker.request(fixture.host.id, scope, availabilityOperation);
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

  it("applies a per-request timeout without changing the default mutation timeout", async () => {
    vi.useFakeTimers();
    const fixture = await setup(1_000);
    const availability = fixture.broker.request(
      fixture.host.id,
      scope,
      availabilityOperation,
      undefined,
      { requestTimeoutMs: 25 }
    );
    const availabilityAssertion = expect(availability).rejects.toMatchObject({
      code: "canvas_runtime_rpc_deadline_exceeded",
      reconcileRequired: false
    });
    const operationId = randomUUID();
    const mutation = fixture.broker.request(fixture.host.id, scope, {
      operation: "claim",
      runtimeLeaseId: randomUUID(),
      evidence: {
        operationId,
        sourceRevision: `snapshot:${"a".repeat(64)}`,
        graphFingerprint: `pkg-${"b".repeat(64)}`
      },
      input: {
        operationId,
        sourceRevision: `snapshot:${"a".repeat(64)}`,
        graphFingerprint: `pkg-${"b".repeat(64)}`
      }
    });
    const availabilityCommand = requestCommand(fixture.deliveries[0]!);
    const mutationCommand = requestCommand(fixture.deliveries[1]!);

    expect(availabilityCommand.deadline).toBe("2026-08-20T00:00:00.025Z");
    expect(mutationCommand.deadline).toBe("2026-08-20T00:00:01.000Z");
    expect(
      fixture.broker.authorizesContentTransfer(fixture.host.id, scope, contentTarget.content)
    ).toBe(true);
    await vi.advanceTimersByTimeAsync(25);
    await availabilityAssertion;
    expect(fixture.broker.pendingCount()).toBe(1);
    expect(
      fixture.broker.authorizesContentTransfer(fixture.host.id, scope, contentTarget.content)
    ).toBe(false);

    fixture.broker.detachHost(fixture.host.id, "disconnected");
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
    const pending = fixture.broker.request(fixture.host.id, scope, availabilityOperation);

    fixture.broker.detachHost(fixture.host.id, reason);

    await expect(pending).rejects.toMatchObject({ code, reconcileRequired: false });
    expect(fixture.broker.pendingCount()).toBe(0);
  });

  it("invalidates an acquired attachment generation after detach", async () => {
    const fixture = await setup();
    const attachmentVersion = fixture.broker.attachmentVersion(fixture.host.id);
    fixture.broker.detachHost(fixture.host.id, "disconnected");

    await expect(
      fixture.broker.request(fixture.host.id, scope, availabilityOperation, attachmentVersion)
    ).rejects.toMatchObject({ code: "canvas_runtime_host_offline" });
    expect(fixture.deliveries).toHaveLength(0);
  });

  it("fails closed and clears pending state for a response from the wrong Host", async () => {
    const fixture = await setup();
    const other = fixture.hosts.register("Other Runtime Host").host;
    fixture.hosts.reportOnline(other.id, [CANVAS_RUNTIME_CAPABILITY], 1);
    fixture.active.add(other.id);
    const pending = fixture.broker.request(fixture.host.id, scope, availabilityOperation);
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
    const pending = fixture.broker.request(fixture.host.id, scope, {
      operation: "acquire",
      contentTarget
    });
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
