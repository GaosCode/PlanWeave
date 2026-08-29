import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  workspaceExecutionEventSchema,
  workspaceExecutionHandleSchema,
  workspaceExecutionSessionStateSchema
} from "../workspaceExecution/browser.js";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

describe("workspace execution architecture boundaries", () => {
  it("keeps the runtime browser graph free of Node, repository, transport, and credentials", async () => {
    const result = await execFileAsync(process.execPath, [
      resolve(repoRoot, "scripts/check-runtime-browser-boundary.mjs")
    ]);
    expect(result.stderr).toBe("");

    const browserEntry = await readFile(
      resolve(repoRoot, "packages/runtime/src/workspaceExecution/browser.ts"),
      "utf8"
    );
    const contracts = await readFile(
      resolve(repoRoot, "packages/runtime/src/workspaceExecution/contracts.ts"),
      "utf8"
    );
    expect(`${browserEntry}\n${contracts}`).not.toMatch(
      /node:|runSessions|repository|credential|authorization|Bearer|fetch\s*\(/
    );
    expect(browserEntry).not.toContain("./node.js");
  });

  it("keeps Node coordination out of the Desktop renderer import graph", async () => {
    const rendererRoot = resolve(repoRoot, "packages/desktop/src/renderer");
    const result = await execFileAsync("rg", [
      "-n",
      "workspaceExecution/(node|coordinator)|WorkspaceExecutionCoordinator",
      rendererRoot
    ]).catch((error: unknown) => error as { stdout?: string; code?: number });
    expect(result).toMatchObject({ code: 1 });
    expect((result as { stdout?: string }).stdout ?? "").toBe("");
  });

  it("rejects free JSON and secrets in persisted handle/session/event contracts", () => {
    const handle = {
      version: "planweave.workspace-execution-handle/v1",
      target: "remote",
      phase: "attempt",
      runSessionId: "SESSION-0001",
      authorityBindingId: `wxb:sha256:${"a".repeat(64)}`,
      scope: { kind: "block", blockRef: "T-001#B-001" },
      capabilities: { interactionResponse: true },
      operationId: "operation-1",
      operationRevision: 1,
      dispatchId: "dispatch-1",
      executionAttemptId: "attempt-1",
      attemptStateVersion: 1,
      leaseId: "lease-1",
      agentEndpointId: "endpoint-1",
      cursor: {
        target: "remote",
        executionAttemptId: "attempt-1",
        eventCursor: 0
      }
    };
    expect(() => workspaceExecutionHandleSchema.parse({ ...handle, token: "secret" })).toThrow();
    expect(() =>
      workspaceExecutionSessionStateSchema.parse({
        version: "planweave.workspace-execution-session/v1",
        binding: {
          version: "planweave.workspace-authority-binding/v1",
          kind: "remote",
          bindingId: handle.authorityBindingId,
          packageWorkspace: "/workspace/project",
          connectionProfileId: "profile-1",
          serverOrigin: "https://planweave.example",
          workspaceId: "workspace-1",
          projectId: "project-1",
          canvasId: "default",
          blockRef: "T-001#B-001",
          authorityRevisions: {
            responsibilityRevision: 1,
            reviewerRevision: 2,
            executionTargetRevision: 3
          },
          contentRevision: "snapshot:revision-1",
          graphFingerprint: `pkg-${"b".repeat(64)}`
        },
        dispatchIntent: {
          schemaVersion: "remote-run/v3",
          projectId: "project-1",
          canvasId: "default",
          blockRef: "T-001#B-001",
          agentEndpointId: "endpoint-1",
          idempotencyKey: "intent-1",
          expectedResponsibilityRevision: 1,
          expectedReviewerRevision: 2,
          executionTargetRevision: 3,
          contentRevision: "snapshot:revision-1",
          graphFingerprint: `pkg-${"b".repeat(64)}`
        },
        handle,
        interactions: [],
        evidence: { status: "pending", diagnostics: [] },
        metadata: { headers: { authorization: "secret" } }
      })
    ).toThrow();
    expect(() =>
      workspaceExecutionSessionStateSchema.parse({
        version: "planweave.workspace-execution-session/v1",
        binding: {
          version: "planweave.workspace-authority-binding/v1",
          kind: "remote",
          bindingId: handle.authorityBindingId,
          packageWorkspace: "/workspace/project",
          connectionProfileId: "profile-1",
          serverOrigin: "https://planweave.example",
          workspaceId: "workspace-1",
          projectId: "project-1",
          canvasId: "default",
          blockRef: "T-001#B-001",
          authorityRevisions: {
            responsibilityRevision: 1,
            reviewerRevision: 2,
            executionTargetRevision: 3
          },
          contentRevision: "snapshot:revision-1",
          graphFingerprint: `pkg-${"b".repeat(64)}`
        },
        dispatchIntent: {
          schemaVersion: "remote-run/v3",
          projectId: "project-1",
          canvasId: "default",
          blockRef: "T-001#B-001",
          agentEndpointId: "endpoint-1",
          idempotencyKey: "intent-1",
          expectedResponsibilityRevision: 1,
          expectedReviewerRevision: 2,
          executionTargetRevision: 3,
          contentRevision: "snapshot:revision-1",
          graphFingerprint: `pkg-${"b".repeat(64)}`
        },
        handle: { ...handle, scope: { kind: "block", blockRef: "T-001#B-002" } },
        interactions: [],
        evidence: { status: "pending", diagnostics: [] }
      })
    ).toThrow();
    expect(() =>
      workspaceExecutionEventSchema.parse({
        version: "planweave.execution-event/v1",
        eventId: "event-1",
        observedAt: "2030-01-01T00:00:00.000Z",
        runSessionId: "SESSION-0001",
        scope: { kind: "block", blockRef: "T-001#B-001" },
        source: {
          target: "remote",
          operationId: "operation-1",
          executionAttemptId: "attempt-1",
          cursor: 1
        },
        type: "operation_observed",
        data: { state: "running", attemptStatus: "running", operationRevision: 1, raw: {} }
      })
    ).toThrow();
  });

  it("binds every persisted remote dispatch intent to the exact content authority", () => {
    const binding = {
      version: "planweave.workspace-authority-binding/v1" as const,
      kind: "remote" as const,
      bindingId: `wxb:sha256:${"a".repeat(64)}`,
      packageWorkspace: "/workspace/project",
      connectionProfileId: "profile-1",
      serverOrigin: "https://planweave.example",
      workspaceId: "workspace-1",
      projectId: "project-1",
      canvasId: "default",
      blockRef: "T-001#B-001",
      authorityRevisions: {
        responsibilityRevision: 1,
        reviewerRevision: 2,
        executionTargetRevision: 3
      },
      contentRevision: "snapshot:revision-1",
      graphFingerprint: `pkg-${"b".repeat(64)}`
    };
    const dispatchIntent = {
      schemaVersion: "remote-run/v3" as const,
      projectId: binding.projectId,
      canvasId: binding.canvasId,
      blockRef: binding.blockRef,
      agentEndpointId: "endpoint-1",
      idempotencyKey: "intent-1",
      expectedResponsibilityRevision: 1,
      expectedReviewerRevision: 2,
      executionTargetRevision: 3,
      contentRevision: binding.contentRevision,
      graphFingerprint: binding.graphFingerprint
    };
    const session = {
      version: "planweave.workspace-execution-session/v1" as const,
      binding,
      dispatchIntent,
      handle: null,
      interactions: [],
      evidence: { status: "pending" as const, diagnostics: [] }
    };

    expect(workspaceExecutionSessionStateSchema.parse(session)).toEqual(session);
    for (const mismatch of [
      { contentRevision: "snapshot:revision-2" },
      { graphFingerprint: `pkg-${"c".repeat(64)}` },
      {
        contentRevision: "snapshot:revision-2",
        graphFingerprint: `pkg-${"c".repeat(64)}`
      }
    ]) {
      expect(() =>
        workspaceExecutionSessionStateSchema.parse({
          ...session,
          dispatchIntent: { ...dispatchIntent, ...mismatch }
        })
      ).toThrow("workspace_execution_dispatch_intent_mismatch");
    }
  });
});
