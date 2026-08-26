import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CANVAS_RUNTIME_CAPABILITY } from "@planweave-ai/agent-host-protocol";
import type { ProjectWorkspace } from "@planweave-ai/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CanvasRuntimeResolverPort } from "../runtime/canvasRuntimeResolver.js";
import { CanvasRuntimeService } from "../runtime/canvasRuntimeService.js";
import { openAgentHostState, type AgentHostState } from "../state/agentHostState.js";

const directories: string[] = [];
const states: AgentHostState[] = [];
const scope = { workspaceId: "workspace-1", projectId: "project-1", canvasId: "default" };
const sourceRevision = `snapshot:${"b".repeat(64)}`;
const graphFingerprint = `pkg-${"a".repeat(64)}`;
const artifactTransfer = {
  updateCredentialToken: vi.fn(),
  synchronizeServerTime: vi.fn(),
  download: vi.fn(async () => new Uint8Array([1])),
  upload: vi.fn(async () => {})
};
const contentTransfer = {
  updateCredentialToken: vi.fn(),
  fetch: vi.fn(async () => {
    throw new Error("unexpected_content_transfer");
  })
};

afterEach(async () => {
  for (const state of states.splice(0)) state.close();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "planweave-canvas-runtime-replay-"));
  directories.push(directory);
  const state = await openAgentHostState(join(directory, "state.sqlite"));
  states.push(state);
  return state;
}

function unusedWorkspace(): ProjectWorkspace {
  return {
    id: "project-1",
    kind: "managed",
    rootPath: "/not-observed",
    sourceRoot: null,
    planweaveHome: "/not-observed",
    workspaceRoot: "/not-observed",
    projectFile: "/not-observed/project.json",
    packageDir: "/not-observed/package",
    manifestFile: "/not-observed/manifest.json",
    stateFile: "/not-observed/state.json",
    resultsDir: "/not-observed/results",
    projectPromptFile: "/not-observed/project-prompt.md"
  };
}

function resolver(): CanvasRuntimeResolverPort {
  const workspace = unusedWorkspace();
  return {
    configured: () => true,
    mappings: () => [],
    resolveProject: async () => workspace,
    resolve: async () => ({ scope, project: workspace, canvas: workspace })
  };
}

function request(
  requestId: string,
  operation: Record<string, unknown> = { operation: "availability" }
) {
  const materializingOperation =
    operation.operation === "availability"
      ? {
          ...operation,
          contentTarget: {
            revision: 1,
            content: {
              versionId: `version-${"c".repeat(64)}`,
              canonicalDigest: "c".repeat(64),
              verification: "complete" as const
            },
            graphFingerprint
          }
        }
      : operation;
  return {
    type: "canvas_runtime.request" as const,
    protocolVersion: 1 as const,
    requestId,
    scope,
    deadline: "2099-01-01T00:00:00.000Z",
    operation: materializingOperation
  };
}

function cancel(requestId: string, targetRequestId: string) {
  return {
    type: "canvas_runtime.cancel" as const,
    protocolVersion: 1 as const,
    requestId,
    targetRequestId,
    scope,
    deadline: "2099-01-01T00:00:00.000Z"
  };
}

function delivery(
  sequence: number,
  command: ReturnType<typeof request> | ReturnType<typeof cancel>
) {
  return {
    type: "mailbox.message" as const,
    protocolVersion: 1 as const,
    sequence,
    previousSequence: sequence - 1,
    messageId: `mailbox-${sequence}`,
    command
  };
}

function response(state: AgentHostState, requestId: string) {
  return state
    .pendingEvents()
    .find((event) => event.type === "canvas_runtime.response" && event.requestId === requestId);
}

function service(state: AgentHostState) {
  return new CanvasRuntimeService({
    resolver: resolver(),
    receipts: state.canvasRuntime,
    capabilities: [CANVAS_RUNTIME_CAPABILITY],
    artifactTransfer,
    contentTransfer
  });
}

describe("Canvas Runtime Host replay", () => {
  it("releases leases idempotently and cancellation cannot replace a terminal response", async () => {
    const state = await setup();
    const runtime = service(state);
    state.canvasRuntime.createLease({
      runtimeLeaseId: "runtime-lease-1",
      ...scope,
      sourceRevision,
      graphFingerprint,
      status: "active",
      acquiredAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z"
    });
    for (const [sequence, requestId] of [
      [1, "request-release-1"],
      [2, "request-release-2"]
    ] as const) {
      const release = request(requestId, {
        operation: "release",
        runtimeLeaseId: "runtime-lease-1"
      });
      state.receive(delivery(sequence, release));
      await runtime.handle(release);
      expect(response(state, requestId)).toMatchObject({
        response: { outcome: "success", result: { released: true } }
      });
    }

    const terminal = request("request-terminal");
    state.receive(delivery(3, terminal));
    state.canvasRuntime.begin(terminal.requestId);
    state.canvasRuntime.complete(terminal.requestId, {
      type: "canvas_runtime.response",
      protocolVersion: 1,
      requestId: terminal.requestId,
      response: {
        outcome: "error",
        operation: "availability",
        error: { code: "runtime_not_attached", message: "Unavailable.", retryable: false }
      }
    });
    const cancellation = cancel("request-cancel-terminal", terminal.requestId);
    state.receive(delivery(4, cancellation));
    await runtime.handle(cancellation);
    expect(response(state, cancellation.requestId)).toMatchObject({
      response: { outcome: "success", result: { cancelled: false } }
    });
    expect(response(state, terminal.requestId)).toMatchObject({
      response: { outcome: "error", error: { code: "runtime_not_attached" } }
    });
  });

  it("marks an in-flight request reconcile-required after Host restart", async () => {
    const state = await setup();
    const command = request("request-restart");
    state.receive(delivery(1, command));
    expect(state.canvasRuntime.begin(command.requestId)).toBe(true);
    service(state).recover();
    expect(response(state, command.requestId)).toMatchObject({
      response: {
        outcome: "error",
        error: { code: "reconcile_required", reconcileRequired: true }
      }
    });
  });
});
