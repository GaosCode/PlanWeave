import { canvasScopeRefSchema } from "@planweave-ai/collaboration-protocol/core/primitives";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CanvasRuntimeUnavailableError } from "../canvas/executionRuntimePort.js";
import { CanvasRuntimeHostAmbiguousError } from "../canvas/runtimeHostLocator.js";
import {
  LocalFirstCanvasRuntimeRouter,
  RemoteHostCanvasRuntimeAdapter
} from "../canvas/remoteHostRuntimeAdapter.js";
import {
  createRemoteHostRuntimeTestEnvironment,
  type RemoteHostRuntimeTestEnvironment,
  respondToRuntimeRequest as respond,
  runtimeRequestCommandAt as commandAt
} from "./support/remoteHostRuntimeTestEnvironment.js";

const environments: RemoteHostRuntimeTestEnvironment[] = [];
const scope = canvasScopeRefSchema.parse({
  workspaceId: "workspace-runtime-availability",
  projectId: "project-runtime-availability",
  canvasId: "default"
});
const runtimeContentTarget = {
  revision: 1,
  content: {
    versionId: `version-${"c".repeat(64)}`,
    canonicalDigest: "c".repeat(64),
    verification: "complete" as const
  },
  graphFingerprint: `pkg-${"a".repeat(64)}`
};

afterEach(() => {
  vi.useRealTimers();
  for (const environment of environments.splice(0)) environment.close();
});

async function setup(
  requestTimeoutMs = 1_000,
  availabilityOptions: {
    requestTimeoutMs?: number;
    diagnosticSink?: ReturnType<typeof vi.fn>;
  } = {}
) {
  const environment = await createRemoteHostRuntimeTestEnvironment({ scope, requestTimeoutMs });
  environments.push(environment);
  const adapter = new RemoteHostCanvasRuntimeAdapter(
    environment.locator,
    environment.broker,
    { read: () => runtimeContentTarget },
    {
      grants: environment.grants,
      artifacts: environment.artifacts
    },
    availabilityOptions
  );

  return {
    ...environment,
    adapter
  };
}

function availableAvailabilityResponse(sourceRevision: string, capturedAt: string) {
  return {
    outcome: "success",
    operation: "availability",
    result: {
      kind: "available",
      sourceRevision,
      graphFingerprint: runtimeContentTarget.graphFingerprint,
      status: {
        schemaVersion: "canvas-runtime-status/v2",
        scope,
        packageFingerprint: runtimeContentTarget.graphFingerprint,
        capturedAt,
        tasks: [],
        blocks: []
      }
    }
  };
}

describe("Remote Host Canvas Runtime availability", () => {
  it("serves remote availability with no local trusted project", async () => {
    const fixture = await setup();
    const router = new LocalFirstCanvasRuntimeRouter(
      {
        async readAvailability() {
          throw new Error("local_should_not_run");
        }
      },
      {
        acquire() {
          throw new CanvasRuntimeUnavailableError();
        }
      },
      { hasRuntimeProject: () => false, hasRuntimeScope: () => false }
    );
    router.attachRemote(fixture.adapter);

    const pending = router.readAvailability(scope, "2026-08-20T00:00:00.000Z");
    const command = commandAt(fixture.deliveries, 0);
    expect(command.operation).toMatchObject({
      operation: "availability",
      contentTarget: runtimeContentTarget
    });
    const graphFingerprint = `pkg-${"a".repeat(64)}`;
    respond(fixture.broker, fixture.host.id, command, {
      outcome: "success",
      operation: "availability",
      result: {
        kind: "available",
        sourceRevision: `snapshot:${"b".repeat(64)}`,
        graphFingerprint,
        status: {
          schemaVersion: "canvas-runtime-status/v2",
          scope,
          packageFingerprint: graphFingerprint,
          capturedAt: "2026-08-20T00:00:00.000Z",
          tasks: [],
          blocks: []
        }
      }
    });

    await expect(pending).resolves.toMatchObject({
      kind: "available",
      hostId: fixture.host.id,
      graphFingerprint,
      status: { scope }
    });
  });

  it("aggregates matching read evidence while generic routing remains ambiguous", async () => {
    const fixture = await setup();
    const second = fixture.addHost("Second Runtime");

    expect(fixture.adapter.hasRuntimeScope(scope)).toBe(true);
    expect(
      fixture.adapter.hasRuntimeProject({
        workspaceId: scope.workspaceId,
        projectId: scope.projectId
      })
    ).toBe(true);
    expect(() => fixture.adapter.acquire(scope)).toThrow(CanvasRuntimeHostAmbiguousError);

    const currentSourceRevision = `snapshot:${"b".repeat(64)}`;
    const pending = fixture.adapter.readAvailabilityForAuthority(scope, undefined, {
      target: runtimeContentTarget,
      sourceRevision: currentSourceRevision
    });
    const staleCommand = commandAt(fixture.deliveries, 0);
    const currentCommand = commandAt(second.deliveries, 0);
    respond(fixture.broker, fixture.host.id, staleCommand, {
      outcome: "success",
      operation: "availability",
      result: {
        kind: "available",
        sourceRevision: `snapshot:${"e".repeat(64)}`,
        graphFingerprint: runtimeContentTarget.graphFingerprint,
        status: {
          schemaVersion: "canvas-runtime-status/v2",
          scope,
          packageFingerprint: runtimeContentTarget.graphFingerprint,
          capturedAt: "2026-08-20T00:00:00.000Z",
          tasks: [],
          blocks: []
        }
      }
    });
    respond(fixture.broker, second.host.id, currentCommand, {
      outcome: "success",
      operation: "availability",
      result: {
        kind: "available",
        sourceRevision: currentSourceRevision,
        graphFingerprint: runtimeContentTarget.graphFingerprint,
        status: {
          schemaVersion: "canvas-runtime-status/v2",
          scope,
          packageFingerprint: runtimeContentTarget.graphFingerprint,
          capturedAt: "2026-08-20T00:00:01.000Z",
          tasks: [],
          blocks: []
        }
      }
    });

    await expect(pending).resolves.toMatchObject({
      kind: "available",
      hostId: second.host.id,
      graphFingerprint: runtimeContentTarget.graphFingerprint
    });
  });

  it("returns exact authority without waiting for a stuck peer and bounds loser cleanup", async () => {
    vi.useFakeTimers();
    const diagnosticSink = vi.fn();
    const fixture = await setup(1_000, { requestTimeoutMs: 50, diagnosticSink });
    fixture.addHost("Stuck Runtime");
    const sourceRevision = `snapshot:${"b".repeat(64)}`;
    const pending = fixture.adapter.readAvailabilityForAuthority(scope, undefined, {
      target: runtimeContentTarget,
      sourceRevision
    });

    respond(
      fixture.broker,
      fixture.host.id,
      commandAt(fixture.deliveries, 0),
      availableAvailabilityResponse(sourceRevision, "2026-08-20T00:00:00.000Z")
    );

    await expect(pending).resolves.toMatchObject({
      kind: "available",
      hostId: fixture.host.id
    });
    expect(fixture.broker.pendingCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(50);
    expect(fixture.broker.pendingCount()).toBe(0);
    expect(diagnosticSink).not.toHaveBeenCalled();
  });

  it("diagnoses unknown peers before and after an exact authority winner", async () => {
    const diagnosticSink = vi.fn();
    const fixture = await setup(1_000, { diagnosticSink });
    const winner = fixture.addHost("Current Runtime");
    const lateFailure = fixture.addHost("Late Failing Runtime");
    const sourceRevision = `snapshot:${"b".repeat(64)}`;
    const pending = fixture.adapter.readAvailabilityForAuthority(scope, undefined, {
      target: runtimeContentTarget,
      sourceRevision
    });

    respond(fixture.broker, fixture.host.id, commandAt(fixture.deliveries, 0), {
      outcome: "error",
      operation: "availability",
      error: {
        code: "runtime_canvas_not_found",
        message: "/private/runtime token=secret-before",
        retryable: false
      }
    });
    await vi.waitFor(() => expect(diagnosticSink).toHaveBeenCalledTimes(1));
    respond(
      fixture.broker,
      winner.host.id,
      commandAt(winner.deliveries, 0),
      availableAvailabilityResponse(sourceRevision, "2026-08-20T00:00:01.000Z")
    );
    await expect(pending).resolves.toMatchObject({ kind: "available", hostId: winner.host.id });

    respond(fixture.broker, lateFailure.host.id, commandAt(lateFailure.deliveries, 0), {
      outcome: "error",
      operation: "availability",
      error: {
        code: "invalid_operation_input",
        message: "/private/runtime token=secret-after",
        retryable: false
      }
    });
    await vi.waitFor(() => expect(diagnosticSink).toHaveBeenCalledTimes(2));
    expect(diagnosticSink.mock.calls).toEqual([
      [
        {
          hostId: fixture.host.id,
          category: "peer_error",
          code: "runtime_canvas_not_found"
        }
      ],
      [
        {
          hostId: lateFailure.host.id,
          category: "peer_error",
          code: "invalid_operation_input"
        }
      ]
    ]);
    expect(JSON.stringify(diagnosticSink.mock.calls)).not.toContain("/private/runtime");
    expect(JSON.stringify(diagnosticSink.mock.calls)).not.toContain("secret");
  });

  it("waits for bounded peers then propagates the first unknown error in Host order", async () => {
    vi.useFakeTimers();
    const diagnosticSink = vi.fn();
    const fixture = await setup(1_000, { requestTimeoutMs: 50, diagnosticSink });
    const second = fixture.addHost("Earlier Failing Runtime");
    const stuck = fixture.addHost("Stuck Runtime");
    const located = fixture.locator.locateCandidates(scope);
    if (located.kind !== "available") throw new Error("test_runtime_hosts_expected");
    const errorCodes = new Map(
      located.hostIds
        .filter((hostId) => hostId !== stuck.host.id)
        .map((hostId, index) => [
          hostId,
          index === 0 ? "first_host_failure" : "second_host_failure"
        ])
    );
    const pending = fixture.adapter.readAvailability(scope);
    const settled = pending.catch((error: unknown) => error);
    const secondErrorCode = errorCodes.get(second.host.id);
    const firstErrorCode = errorCodes.get(fixture.host.id);
    if (!secondErrorCode || !firstErrorCode) throw new Error("test_runtime_error_order_missing");

    respond(fixture.broker, second.host.id, commandAt(second.deliveries, 0), {
      outcome: "error",
      operation: "availability",
      error: {
        code: secondErrorCode,
        message: "Second failed.",
        retryable: false
      }
    });
    respond(fixture.broker, fixture.host.id, commandAt(fixture.deliveries, 0), {
      outcome: "error",
      operation: "availability",
      error: {
        code: firstErrorCode,
        message: "First failed.",
        retryable: false
      }
    });
    await vi.advanceTimersByTimeAsync(49);
    expect(fixture.broker.pendingCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(settled).resolves.toMatchObject({ code: "first_host_failure" });
    expect(fixture.broker.pendingCount()).toBe(0);
  });

  it("does not hide unexpected locator failures in scope availability", async () => {
    const fixture = await setup();
    vi.spyOn(fixture.locator, "locateCandidates").mockImplementationOnce(() => {
      throw new Error("unexpected_locator_failure");
    });

    expect(() => fixture.adapter.hasRuntimeScope(scope)).toThrow("unexpected_locator_failure");
  });

  it("returns a safe unavailable result when no Host provides matching evidence", async () => {
    const fixture = await setup();
    const second = fixture.addHost("Second Runtime");
    const pending = fixture.adapter.readAvailability(scope);
    const failedCommand = commandAt(fixture.deliveries, 0);
    const mismatchedCommand = commandAt(second.deliveries, 0);
    respond(fixture.broker, fixture.host.id, failedCommand, {
      outcome: "success",
      operation: "availability",
      result: { kind: "unavailable", reason: "host_offline" }
    });
    const mismatchedFingerprint = `pkg-${"d".repeat(64)}`;
    respond(fixture.broker, second.host.id, mismatchedCommand, {
      outcome: "success",
      operation: "availability",
      result: {
        kind: "available",
        sourceRevision: `snapshot:${"e".repeat(64)}`,
        graphFingerprint: mismatchedFingerprint,
        status: {
          schemaVersion: "canvas-runtime-status/v2",
          scope,
          packageFingerprint: mismatchedFingerprint,
          capturedAt: "2026-08-20T00:00:00.000Z",
          tasks: [],
          blocks: []
        }
      }
    });

    await expect(pending).resolves.toMatchObject({
      kind: "unavailable",
      reason: "content_out_of_sync"
    });
  });

  it("contains rejected Host reads instead of rejecting availability", async () => {
    const fixture = await setup(10);

    await expect(fixture.adapter.readAvailability(scope)).resolves.toMatchObject({
      kind: "unavailable",
      reason: "host_offline",
      hostId: fixture.host.id
    });
  });

  it("prefers an attached-but-missing Runtime over another offline Host", async () => {
    const fixture = await setup();
    const second = fixture.addHost("Second Runtime");
    const pending = fixture.adapter.readAvailability(scope);
    const secondCommand = commandAt(second.deliveries, 0);

    respond(fixture.broker, second.host.id, secondCommand, {
      outcome: "success",
      operation: "availability",
      result: { kind: "unavailable", reason: "runtime_not_attached" }
    });
    fixture.disconnectHost(fixture.host.id);

    await expect(pending).resolves.toMatchObject({
      kind: "unavailable",
      reason: "runtime_not_attached",
      hostId: second.host.id
    });
  });

  it("does not hide an unclassified Host domain error", async () => {
    const fixture = await setup();
    const pending = fixture.adapter.readAvailability(scope);
    respond(fixture.broker, fixture.host.id, commandAt(fixture.deliveries, 0), {
      outcome: "error",
      operation: "availability",
      error: {
        code: "runtime_canvas_not_found",
        message: "The Canvas Runtime resolver failed.",
        retryable: false
      }
    });

    await expect(pending).rejects.toMatchObject({ code: "runtime_canvas_not_found" });
  });
});
